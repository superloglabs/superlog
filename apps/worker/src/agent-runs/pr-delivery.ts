import {
  type AgentPullRequestProviderObservation,
  type AgentRunResult,
  type DB,
  createIncidentLifecycle,
  db,
  normalizePrBaseBranch,
  reconcileAgentPullRequestProviderObservation,
  schema,
  withDatabaseAdvisoryLocks,
} from "@superlog/db";
import { and, desc, eq, gte, isNull, lte, ne, or } from "drizzle-orm";
import { type AgentRunFindings, assembleAgentRunResult } from "../agent-outcome-tools.js";
import {
  type AgentRunContext,
  type InstalledGithubRepo,
  listAccessibleGithubRepositories,
} from "../agent-run-context.js";
import { createAgentRunLifecycle } from "../agent-run.js";
import {
  closeAgentPullRequestOnGithub,
  findGithubPullRequestDelivery,
  mergeAgentPullRequest,
  pushPatchToExistingAgentPr,
  validateAgentPatchApplicability,
} from "../github-app.js";
import { buildContextIncidentUrl } from "../incident-route.js";
import { downloadAgentPatchFile } from "../infra/agent-runner/patch-files.js";
import { openAgentRunPullRequest } from "../infra/github/pull-requests.js";
import { postLinearIncidentResponse } from "../infra/linear/agent-session.js";
import {
  incidentBlocks,
  postIncidentThreadMessage,
  updateIncidentMainMessage,
} from "../infra/slack/incident-messages.js";
import { logger } from "../logger.js";
import { enqueueAgentRunCompleted } from "../webhooks.js";
import {
  type MarkAgentPullRequestClosedResult,
  type PullRequestDeliveryIdentity,
  PullRequestDeliveryReceiptConflictError,
  type PullRequestMutationReconciliation,
  type RecordedPullRequestDelivery,
  findRecordedPullRequestDelivery,
  markAgentPullRequestClosedAfterDeliveryAbort,
  recordFiledLinearTicket,
  recordOpenedAgentPullRequest,
  recordUpdatedAgentPullRequest,
} from "./deliverable-records.js";
import type { DeliveredLinearTicket } from "./linear-delivery.js";
import { scheduleLinearHandoff } from "./linear-handoff.js";
import { linearTicketSlackReference } from "./linear-pr-linking.js";
import { outcomeActionInputHash } from "./outcome-action-receipts.js";
import { buildLegacyPrReceiptTitle, buildPrBody, buildPrTitle } from "./pr-copy.js";
import { summarizePrOpenFailure } from "./pr-open-failure.js";
import {
  failAgentRun,
  publishAwaitingEventsUpdateIfCurrent,
  reconcileStaleAgentRunPublication,
} from "./status.js";

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:5173";
const DEFAULT_COMMIT_AUTHOR = {
  name: "Superlog app",
  email: "bot@superlog.sh",
};
const agentRunLifecycle = createAgentRunLifecycle(db);
const incidentLifecycle = createIncidentLifecycle(db);

type PullRequestPublicationDependencies = {
  canPublish(input: {
    id: string;
    incidentId: string;
    state: schema.AgentRun["state"];
  }): Promise<boolean>;
  reconcile(ctx: AgentRunContext): Promise<void>;
};

const pullRequestPublicationDependencies: PullRequestPublicationDependencies = {
  canPublish: (input) => agentRunLifecycle.canPublishStatusUpdate(input),
  reconcile: reconcileStaleAgentRunPublication,
};

export async function publishPullRequestUpdateIfCurrent(
  ctx: AgentRunContext,
  state: schema.AgentRun["state"],
  publish: () => Promise<void>,
  deps: PullRequestPublicationDependencies = pullRequestPublicationDependencies,
): Promise<boolean> {
  const outcome = await publishAwaitingEventsUpdateIfCurrent({
    isCurrent: () => deps.canPublish({ id: ctx.agentRun.id, incidentId: ctx.incident.id, state }),
    publish,
    reconcileStalePublication: () => deps.reconcile(ctx),
  });
  return outcome === "published";
}

// Reply posted on the existing PR after a follow-up run pushes new commits.
function buildFollowUpPrComment(ctx: AgentRunContext, result: AgentRunResult): string {
  const interactions = ctx.followUp?.interactions ?? [];
  const authors = [...new Set(interactions.map((i) => i.author).filter((a): a is string => !!a))];
  const lines = [
    authors.length > 0
      ? `Addressed review feedback from ${authors.map((a) => `@${a}`).join(", ")} in a follow-up investigation.`
      : "Addressed review feedback in a follow-up investigation.",
    "",
    result.summary,
  ];
  const validation = result.pr?.validationSummary;
  if (validation) lines.push("", `Validation: ${validation}`);
  return lines.join("\n");
}

// Files/reuses this run's Linear ticket from the result (platform-side,
// deterministic) and records it. Best-effort: PR delivery never fails on
// ticket problems.
async function deliverAndRecordLinearTicket(
  ctx: AgentRunContext,
  result: AgentRunResult,
  prUrl: string,
): Promise<DeliveredLinearTicket | null> {
  try {
    const ticket = await scheduleLinearHandoff(ctx, result, `pr:${prUrl}`);
    if (ticket) return ticket;
    if (result.linearTicket) {
      // Legacy in-flight run finishing on the old contract: preserve its
      // self-reported ticket link.
      await recordFiledLinearTicket(ctx, result.linearTicket);
    }
  } catch (err) {
    logger.error(
      {
        scope: "agent_run.pr_delivery",
        agent_run_id: ctx.agentRun.id,
        incident_id: ctx.incident.id,
        err: err instanceof Error ? err.message : String(err),
      },
      "failed to deliver/record Linear ticket",
    );
  }
  return null;
}

async function notifyFollowUpPrUpdated(
  ctx: AgentRunContext,
  prUrl: string,
  ticket: DeliveredLinearTicket | null,
): Promise<void> {
  const ticketLine = ticket ? `\n${linearTicketSlackReference(ticket)}` : "";
  await postIncidentThreadMessage(
    ctx.incident.id,
    `:arrows_counterclockwise: Follow-up investigation pushed an update to the existing PR: ${prUrl}${ticketLine}`,
  );
}

export function resolvePullRequestBaseBranch(
  ctx: Pick<AgentRunContext, "prBaseBranch">,
  pr: Pick<schema.AgentRunPr, "baseBranch">,
): string | null {
  return normalizePrBaseBranch(ctx.prBaseBranch) ?? normalizePrBaseBranch(pr.baseBranch);
}

export function pullRequestDeliveryIdentityForLegacyCompletion(args: {
  agentRunId: string;
  repoFullName: string;
  requestedBranchName: string;
  input: unknown;
}): PullRequestDeliveryIdentity {
  const input =
    args.input && typeof args.input === "object" && !Array.isArray(args.input)
      ? (args.input as Record<string, unknown>)
      : null;
  const receiptInput =
    input && typeof input.title === "string"
      ? { ...input, title: buildLegacyPrReceiptTitle(input.title) }
      : args.input;
  return {
    // The provider marker must survive retries of the same durable run and
    // repository, even when two pollers reach delivery concurrently.
    deliveryId: outcomeActionInputHash({
      scope: "legacy_pull_request_delivery",
      agentRunId: args.agentRunId,
      repoFullName: args.repoFullName,
    }),
    // Keep hashes compatible with receipts written before explicit titles
    // began passing through to GitHub unchanged.
    inputHash: outcomeActionInputHash(receiptInput),
    requestedBranchName: args.requestedBranchName,
  };
}

export async function completeWithPullRequest(
  ctx: AgentRunContext,
  result: AgentRunResult,
  pr: schema.AgentRunPr,
  sessionId: string,
  runtimeMinutes: number,
): Promise<boolean> {
  if (ctx.githubInstalls.length === 0) {
    await failAgentRun(ctx, "pr_open_failed", "Cannot open a PR without a GitHub installation.", {
      existingResult: result,
    });
    return false;
  }

  let repoMeta: InstalledGithubRepo | undefined;
  try {
    const repos = await listAccessibleGithubRepositories(ctx);
    repoMeta = repos.find((repo) => repo.fullName === pr.selectedRepoFullName);
  } catch (err) {
    await failAgentRun(
      ctx,
      "github_repo_discovery_failed",
      "Cannot open a PR because GitHub repositories could not be listed.",
      { existingResult: result, err },
    );
    return false;
  }
  if (!repoMeta) {
    await failAgentRun(
      ctx,
      "pr_open_failed",
      `Cannot open a PR because GitHub no longer grants access to ${pr.selectedRepoFullName}.`,
      { existingResult: result },
    );
    return false;
  }
  const proposedBranch = pr.branchName?.trim();
  const branchName = proposedBranch
    ? proposedBranch.startsWith("superlog/")
      ? proposedBranch
      : `superlog/${proposedBranch.replace(/^[^/]+\//, "")}`
    : `superlog/${ctx.incident.id.replace(/[^a-zA-Z0-9/_-]/g, "-").slice(0, 48)}`;
  let patch = pr.patch;
  let patchFileId = pr.patchFileId ?? null;

  if (!patch && (pr.patchFileId || pr.patchFilePath)) {
    try {
      const downloaded = await downloadAgentPatchFile({
        sessionId,
        patchFileId: pr.patchFileId,
        patchFilePath: pr.patchFilePath,
      });
      patch = downloaded.patch;
      patchFileId = downloaded.fileId;
    } catch (err) {
      await failAgentRun(
        ctx,
        "pr_open_failed",
        "Failed to download the patch file for PR creation.",
        { existingResult: result, err },
      );
      return false;
    }
  }

  if (!patch) {
    await failAgentRun(
      ctx,
      "pr_open_failed",
      "Cannot open a PR without a patch file or patch body.",
      {
        existingResult: result,
      },
    );
    return false;
  }
  pr.changedFiles = normalizedChangedFiles([
    ...(pr.changedFiles ?? []),
    ...changedFilesFromUnifiedDiff(patch),
  ]);

  const prTitle = buildPrTitle({ ctx, result, pr });
  const prBody = buildPrBody({
    incidentUrl: buildContextIncidentUrl(WEB_ORIGIN, ctx),
    result,
    pr,
  });
  // Persist the resolved patch onto the result we hand to failAgentRun, so a
  // later "retry PR" can re-attempt delivery from the patch on record without
  // depending on the agent session (which may have expired) to re-download it.
  const resultWithPatch: AgentRunResult = { ...result, pr: { ...pr, patch, patchFileId } };
  const deliveryIdentity = pullRequestDeliveryIdentityForLegacyCompletion({
    agentRunId: ctx.agentRun.id,
    repoFullName: pr.selectedRepoFullName,
    requestedBranchName: branchName,
    input: {
      patch,
      branchName,
      baseBranch: resolvePullRequestBaseBranch(ctx, pr),
      title: prTitle,
      body: prBody,
    },
  });
  let recordedDelivery: RecordedPullRequestDelivery | null;
  try {
    recordedDelivery = await findRecordedPullRequestDelivery({
      incidentId: ctx.incident.id,
      agentRunId: ctx.agentRun.id,
      identity: deliveryIdentity,
      repoFullName: pr.selectedRepoFullName,
    });
  } catch (err) {
    await failAgentRun(
      ctx,
      "pr_open_failed",
      "Cannot resume PR delivery because its durable receipt conflicts with this result.",
      { existingResult: resultWithPatch, err },
    );
    return false;
  }

  // Land onto the incident's still-open PR whenever one exists: a resumed or
  // follow-up turn pushes the patch as an additional commit on the existing
  // branch and replies on the PR instead of opening a second one. Keyed on the
  // open PR (not the trigger) because a resumed run keeps its original
  // `incident` trigger yet must still update its own PR rather than duplicate it.
  {
    const existingPr = await db.query.agentPullRequests.findFirst({
      where: and(
        eq(schema.agentPullRequests.incidentId, ctx.incident.id),
        eq(schema.agentPullRequests.repoFullName, pr.selectedRepoFullName),
        ...(recordedDelivery
          ? [eq(schema.agentPullRequests.prNumber, recordedDelivery.prNumber)]
          : []),
        eq(schema.agentPullRequests.state, "open"),
      ),
      orderBy: [desc(schema.agentPullRequests.createdAt)],
    });
    if (existingPr) {
      const guardedUpdate = await guardProposedPullRequestOverlap(
        {
          projectId: ctx.project.id,
          currentIncidentId: ctx.incident.id,
          currentIncidentFirstSeen: ctx.incident.firstSeen,
          currentIncidentService: ctx.incident.service,
          repoFullName: pr.selectedRepoFullName,
          changedFiles: pr.changedFiles ?? [],
        },
        async () => {
          let pushed: { headSha: string };
          try {
            pushed = await pushPatchToExistingAgentPr({
              installationId: repoMeta.installation.installationId,
              repositoryId: repoMeta.id,
              repoFullName: pr.selectedRepoFullName,
              patch,
              branchName: existingPr.branchName,
              prNumber: existingPr.prNumber,
              commitTitle: prTitle,
              commentBody: buildFollowUpPrComment(ctx, result),
              commitAuthor:
                repoMeta.installation.commitAuthorName && repoMeta.installation.commitAuthorEmail
                  ? {
                      name: repoMeta.installation.commitAuthorName,
                      email: repoMeta.installation.commitAuthorEmail,
                    }
                  : DEFAULT_COMMIT_AUTHOR,
              deliveryId: deliveryIdentity.deliveryId,
            });
          } catch (err) {
            return { kind: "push_failed" as const, error: summarizePrOpenFailure(err), err };
          }

          const reconciled = await reconcileGithubPullRequestMutation({
            incidentId: ctx.incident.id,
            agentRunId: ctx.agentRun.id,
            deliveryIdentity,
            pullRequest: {
              repoFullName: existingPr.repoFullName,
              branchName: existingPr.branchName,
              prUrl: existingPr.url,
              prNumber: existingPr.prNumber,
              prNodeId: existingPr.prNodeId,
            },
            installationId: repoMeta.installation.installationId,
            fallbackInstallationIds: ctx.githubInstalls.map(
              ({ installation }) => installation.installationId,
            ),
            canonicalRecordRequiredOnFailure: true,
            reconcile: () =>
              recordUpdatedAgentPullRequest({
                incidentId: ctx.incident.id,
                agentRunId: ctx.agentRun.id,
                agentPullRequestId: existingPr.id,
                repoFullName: existingPr.repoFullName,
                prNumber: existingPr.prNumber,
                headSha: pushed.headSha,
                changedFiles: pr.changedFiles,
                url: existingPr.url,
                branchName: existingPr.branchName,
                deliveryIdentity,
              }),
          });
          return { kind: "updated" as const, reconciled };
        },
      );
      if (!guardedUpdate.ok) {
        const blocked = blockedByOverlappingPullRequest(ctx, guardedUpdate.overlap);
        await failAgentRun(ctx, "pr_open_failed", blocked.error, {
          existingResult: resultWithPatch,
        });
        return false;
      }
      if (guardedUpdate.value.kind === "push_failed") {
        await failAgentRun(ctx, "pr_open_failed", guardedUpdate.value.error, {
          existingResult: resultWithPatch,
          err: guardedUpdate.value.err,
        });
        return false;
      }
      const { reconciled } = guardedUpdate.value;
      if (!reconciled.ok) {
        await failAgentRun(ctx, "pr_open_failed", reconciled.error, {
          existingResult: resultWithPatch,
        });
        return false;
      }

      const followUpResult: AgentRunResult = {
        ...result,
        pr: {
          ...pr,
          patch,
          patchFileId,
          branchName: existingPr.branchName,
          baseBranch: existingPr.baseBranch,
          openStatus: "opened",
          url: existingPr.url,
        },
      };
      const completed = await agentRunLifecycle.completeWithPullRequest({
        id: ctx.agentRun.id,
        currentState: ctx.agentRun.state,
        result: followUpResult,
        selectedRepoFullName: pr.selectedRepoFullName,
        selectedBaseBranch: existingPr.baseBranch,
        prUrl: existingPr.url,
      });
      // A concurrent sync pass already owns all completion-side effects.
      if (!completed) return false;
      await enqueueAgentRunCompleted(ctx.agentRun.id).catch((err) =>
        logger.error(
          {
            scope: "webhooks.enqueue",
            agent_run_id: ctx.agentRun.id,
            err: err instanceof Error ? err.message : String(err),
          },
          "failed to enqueue agent run.completed webhook",
        ),
      );
      await publishPullRequestUpdateIfCurrent(ctx, "complete", async () => {
        await incidentLifecycle
          .applyAgentRunResult({
            incident: ctx.incident,
            agentRunId: ctx.agentRun.id,
            result: followUpResult,
          })
          .catch((err) =>
            logger.error(
              {
                scope: "agent_run.pr_delivery",
                agent_run_id: ctx.agentRun.id,
                incident_id: ctx.incident.id,
                err: err instanceof Error ? err.message : String(err),
              },
              "failed to apply incident metadata after updating PR",
            ),
          );
        const linearTicket = await deliverAndRecordLinearTicket(ctx, result, existingPr.url);
        await notifyFollowUpPrUpdated(ctx, existingPr.url, linearTicket).catch((err) =>
          logger.warn(
            {
              scope: "agent_run.pr_delivery",
              agent_run_id: ctx.agentRun.id,
              err: err instanceof Error ? err.message : String(err),
            },
            "failed to post follow-up PR update to Slack",
          ),
        );
        logger.info(
          {
            scope: "agent_run",
            agent_run_id: ctx.agentRun.id,
            incident_id: ctx.incident.id,
            session_id: sessionId,
            runtime_minutes: runtimeMinutes,
            selected_repo: pr.selectedRepoFullName,
            pr_url: existingPr.url,
          },
          "agent run complete (existing pr updated)",
        );
        await postLinearIncidentResponse(
          ctx.incident.id,
          `${result.summary}\n\nUpdated pull request: ${existingPr.url}`,
        );
      });
      return true;
    }
    // No open PR to land on (closed meanwhile, or the prior run never opened
    // one) — fall through to the normal open-a-new-PR path.
  }
  const guarded = await guardProposedPullRequestOverlap(
    {
      projectId: ctx.project.id,
      currentIncidentId: ctx.incident.id,
      currentIncidentFirstSeen: ctx.incident.firstSeen,
      currentIncidentService: ctx.incident.service,
      repoFullName: pr.selectedRepoFullName,
      changedFiles: pr.changedFiles ?? [],
    },
    async () => {
      let opened: Awaited<ReturnType<typeof openAgentRunPullRequest>>;
      try {
        opened = await openAgentRunPullRequest({
          installationId: repoMeta.installation.installationId,
          repositoryId: repoMeta.id,
          repoFullName: pr.selectedRepoFullName,
          patch,
          branchName,
          baseBranch: resolvePullRequestBaseBranch(ctx, pr),
          title: prTitle,
          body: prBody,
          commitAuthor:
            repoMeta.installation.commitAuthorName && repoMeta.installation.commitAuthorEmail
              ? {
                  name: repoMeta.installation.commitAuthorName,
                  email: repoMeta.installation.commitAuthorEmail,
                }
              : DEFAULT_COMMIT_AUTHOR,
          deliveryId: deliveryIdentity.deliveryId,
        });
      } catch (err) {
        return { kind: "open_failed" as const, error: summarizePrOpenFailure(err), err };
      }

      const reconciled = await reconcileGithubPullRequestMutation({
        incidentId: ctx.incident.id,
        agentRunId: ctx.agentRun.id,
        deliveryIdentity,
        pullRequest: {
          repoFullName: pr.selectedRepoFullName,
          branchName: opened.branchName,
          prUrl: opened.prUrl,
          prNumber: opened.prNumber,
          prNodeId: opened.prNodeId,
        },
        installationId: repoMeta.installation.installationId,
        fallbackInstallationIds: ctx.githubInstalls.map(
          ({ installation }) => installation.installationId,
        ),
        canonicalRecordRequiredOnFailure: false,
        reconcile: () =>
          recordOpenedAgentPullRequest({
            incidentId: ctx.incident.id,
            agentRunId: ctx.agentRun.id,
            installationRowId: repoMeta.installation.id,
            repoFullName: pr.selectedRepoFullName,
            prNumber: opened.prNumber,
            prNodeId: opened.prNodeId,
            url: opened.prUrl,
            branchName: opened.branchName,
            baseBranch: opened.baseBranch,
            headSha: opened.headSha,
            changedFiles: pr.changedFiles,
            title: prTitle,
            authorLogin: opened.authorLogin,
            authorGithubId: opened.authorGithubId,
            authorAvatarUrl: opened.authorAvatarUrl,
            state: opened.state,
            mergedAt: opened.mergedAt,
            deliveryIdentity,
          }),
      });
      return { kind: "delivered" as const, opened, reconciled };
    },
  );
  if (!guarded.ok) {
    const blocked = blockedByOverlappingPullRequest(ctx, guarded.overlap);
    await failAgentRun(ctx, "pr_open_failed", blocked.error, { existingResult: resultWithPatch });
    return false;
  }
  if (guarded.value.kind === "open_failed") {
    await failAgentRun(ctx, "pr_open_failed", guarded.value.error, {
      existingResult: resultWithPatch,
      err: guarded.value.err,
    });
    return false;
  }
  const { opened, reconciled } = guarded.value;
  if (!reconciled.ok) {
    await failAgentRun(ctx, "pr_open_failed", reconciled.error, {
      existingResult: resultWithPatch,
    });
    return false;
  }

  const updatedResult: AgentRunResult = {
    ...result,
    pr: {
      ...pr,
      patch,
      patchFileId,
      branchName: opened.branchName,
      baseBranch: opened.baseBranch,
      openStatus: "opened",
      url: opened.prUrl,
    },
  };
  const completed = await agentRunLifecycle.completeWithPullRequest({
    id: ctx.agentRun.id,
    currentState: ctx.agentRun.state,
    result: updatedResult,
    selectedRepoFullName: pr.selectedRepoFullName,
    selectedBaseBranch: opened.baseBranch,
    prUrl: opened.prUrl,
  });
  // GitHub/canonical delivery precedes the run transition, but every
  // completion notification belongs exclusively to the transition winner.
  if (!completed) return false;
  await enqueueAgentRunCompleted(ctx.agentRun.id).catch((err) =>
    logger.error(
      {
        scope: "webhooks.enqueue",
        agent_run_id: ctx.agentRun.id,
        err: err instanceof Error ? err.message : String(err),
      },
      "failed to enqueue agent run.completed webhook",
    ),
  );
  await publishPullRequestUpdateIfCurrent(ctx, "complete", async () => {
    await incidentLifecycle
      .applyAgentRunResult({
        incident: ctx.incident,
        agentRunId: ctx.agentRun.id,
        result: updatedResult,
      })
      .catch((err) =>
        logger.error(
          {
            scope: "agent_run.pr_delivery",
            agent_run_id: ctx.agentRun.id,
            incident_id: ctx.incident.id,
            err: err instanceof Error ? err.message : String(err),
          },
          "failed to apply incident metadata after opening PR",
        ),
      );
    if (
      ctx.autoMergeFixPrs !== "never" &&
      (await agentRunLifecycle.canPublishStatusUpdate({
        id: ctx.agentRun.id,
        incidentId: ctx.incident.id,
        state: "complete",
      }))
    ) {
      try {
        const outcome = await mergeAgentPullRequest({
          installationId: repoMeta.installation.installationId,
          repositoryId: repoMeta.id,
          repoFullName: pr.selectedRepoFullName,
          prNumber: opened.prNumber,
          prNodeId: opened.prNodeId,
          policy: ctx.autoMergeFixPrs,
          method: ctx.autoMergeMethod,
        });
        logger.info(
          {
            scope: "agent_run.pr_delivery.auto_merge",
            agent_run_id: ctx.agentRun.id,
            incident_id: ctx.incident.id,
            pr_url: opened.prUrl,
            policy: ctx.autoMergeFixPrs,
            method: ctx.autoMergeMethod,
            outcome: outcome.kind,
          },
          "auto-merge applied",
        );
        const note =
          outcome.kind === "merged"
            ? `:white_check_mark: Auto-merged PR (${ctx.autoMergeMethod})`
            : outcome.kind === "auto_merge_enabled"
              ? `:hourglass_flowing_sand: Auto-merge enabled — will land once checks pass (${ctx.autoMergeMethod})`
              : null;
        if (note) {
          await postIncidentThreadMessage(ctx.incident.id, note).catch(() => {});
        }
      } catch (err) {
        logger.warn(
          {
            scope: "agent_run.pr_delivery.auto_merge",
            agent_run_id: ctx.agentRun.id,
            incident_id: ctx.incident.id,
            pr_url: opened.prUrl,
            policy: ctx.autoMergeFixPrs,
            method: ctx.autoMergeMethod,
            err: err instanceof Error ? err.message : String(err),
          },
          "auto-merge attempt failed; leaving PR open for human merge",
        );
        const reason = err instanceof Error ? err.message : String(err);
        await postIncidentThreadMessage(
          ctx.incident.id,
          `:warning: Auto-merge failed (${reason.slice(0, 200)}). PR is open for manual review.`,
        ).catch(() => {});
      }
    }
    const linearTicket = await deliverAndRecordLinearTicket(ctx, result, opened.prUrl);
    logger.info(
      {
        scope: "agent_run",
        agent_run_id: ctx.agentRun.id,
        incident_id: ctx.incident.id,
        session_id: sessionId,
        runtime_minutes: runtimeMinutes,
        selected_repo: pr.selectedRepoFullName,
        pr_url: opened.prUrl,
      },
      "agent run complete (pr opened)",
    );
    const ticketLine = linearTicket ? `\n${linearTicketSlackReference(linearTicket)}` : "";
    await postIncidentThreadMessage(
      ctx.incident.id,
      `:bulb: Opened PR ${opened.prUrl}${ticketLine}`,
    ).catch((err) =>
      logger.error(
        {
          scope: "agent_run.pr_delivery",
          agent_run_id: ctx.agentRun.id,
          incident_id: ctx.incident.id,
          pr_url: opened.prUrl,
          err: err instanceof Error ? err.message : String(err),
        },
        "failed to post PR-ready Slack thread message",
      ),
    );
    const incidentUrl = buildContextIncidentUrl(WEB_ORIGIN, ctx);
    await updateIncidentMainMessage(
      ctx.incident.id,
      `:bulb: PR Ready: ${ctx.incident.title}`,
      incidentBlocks({
        emoji: "bulb",
        status: "PR Ready",
        title: ctx.incident.title,
        titleUrl: incidentUrl,
        tagline: result.summary || undefined,
        service: ctx.incident.service,
        buttons: [],
        links: [
          { text: "View PR", url: opened.prUrl },
          ...(linearTicket?.url ? [{ text: "View ticket", url: linearTicket.url }] : []),
        ],
        incidentId: ctx.incident.id,
        showResolveButton: true,
        showMergePrButton: true,
        showFeedbackButtons: true,
      }),
    ).catch((err) =>
      logger.error(
        {
          scope: "agent_run.pr_delivery",
          agent_run_id: ctx.agentRun.id,
          incident_id: ctx.incident.id,
          pr_url: opened.prUrl,
          err: err instanceof Error ? err.message : String(err),
        },
        "failed to update PR-ready Slack root message",
      ),
    );
    await postLinearIncidentResponse(
      ctx.incident.id,
      `${result.summary}\n\nProposed fix: ${opened.prUrl}`,
    );
  });
  return true;
}

// ---------------------------------------------------------------------------
// Terminal-for-turn PR delivery
// ---------------------------------------------------------------------------

export type PullRequestManualReconciliation = {
  actionRequired: "close_pull_request" | "sync_canonical_state";
  repoFullName: string;
  branchName: string;
  prUrl: string;
  prNumber: number;
  reconciliationReason: "incident_not_open" | "reconciliation_failed";
  reconciliationError: string | null;
  closeError: string | null;
  canonicalState: schema.AgentPrState | null;
};

export type ProposedPullRequestCompensationFailure =
  | {
      ok: false;
      error: string;
      deliveryStatus: "retryable";
      retryable: true;
      manualReconciliation?: never;
    }
  | {
      ok: false;
      error: string;
      deliveryStatus: "incident_not_open";
      retryable: false;
      incidentStatus: schema.IncidentStatus | null;
      manualReconciliation?: never;
    }
  | {
      ok: false;
      error: string;
      deliveryStatus: "manual_reconciliation_required";
      retryable: false;
      manualReconciliation: PullRequestManualReconciliation;
    };

export type ProposedPullRequestDeliveryResult =
  | {
      ok: true;
      url: string;
      prNumber: number;
      branchName: string;
      // True when the patch landed as a follow-up commit on an existing open
      // PR with the same branch, instead of opening a new one.
      updatedExisting: boolean;
    }
  | {
      ok: false;
      error: string;
      deliveryStatus?: never;
      retryable?: never;
      manualReconciliation?: never;
    }
  | ProposedPullRequestCompensationFailure;

type PullRequestDeliveryCompensationReason =
  | { kind: "incident_not_open"; incidentStatus: schema.IncidentStatus | null }
  | {
      kind: "reconciliation_failed";
      error: string;
      canonicalRecordRequired?: boolean;
    };

type PullRequestDeliveryCoordinates = {
  repoFullName: string;
  branchName: string;
  prUrl: string;
  prNumber: number;
};

function reconciliationError(reason: PullRequestDeliveryCompensationReason): string | null {
  return reason.kind === "reconciliation_failed" ? reason.error : null;
}

function manualReconciliationFailure(opts: {
  pullRequest: PullRequestDeliveryCoordinates;
  reason: PullRequestDeliveryCompensationReason;
  actionRequired: PullRequestManualReconciliation["actionRequired"];
  closeError: string | null;
  canonicalState: schema.AgentPrState | null;
  error: string;
}): ProposedPullRequestCompensationFailure {
  return {
    ok: false,
    deliveryStatus: "manual_reconciliation_required",
    retryable: false,
    error: opts.error,
    manualReconciliation: {
      actionRequired: opts.actionRequired,
      ...opts.pullRequest,
      reconciliationReason: opts.reason.kind,
      reconciliationError: reconciliationError(opts.reason),
      closeError: opts.closeError,
      canonicalState: opts.canonicalState,
    },
  };
}

function retryableCompensationFailure(opts: {
  pullRequest: PullRequestDeliveryCoordinates;
  error: string;
}): ProposedPullRequestCompensationFailure {
  return {
    ok: false,
    deliveryStatus: "retryable",
    retryable: true,
    error: `The PR at ${opts.pullRequest.prUrl} was closed after its canonical record could not be reconciled (${opts.error}). It is safe to retry this PR delivery.`,
  };
}

export class PullRequestDeliveryRecoveryPendingError extends Error {
  override readonly name = "PullRequestDeliveryRecoveryPendingError";
}

export async function compensatePullRequestDelivery<CloseSuccess extends { ok: true }>(opts: {
  pullRequest: PullRequestDeliveryCoordinates;
  reason: PullRequestDeliveryCompensationReason;
  closePullRequest: () => Promise<CloseSuccess | { ok: false; error: string }>;
  markCanonicalClosed: (close: CloseSuccess) => Promise<MarkAgentPullRequestClosedResult>;
}): Promise<ProposedPullRequestCompensationFailure> {
  const closed = await opts.closePullRequest();
  if (!closed.ok) {
    return manualReconciliationFailure({
      pullRequest: opts.pullRequest,
      reason: opts.reason,
      actionRequired: "close_pull_request",
      closeError: closed.error,
      canonicalState: null,
      error: `The PR at ${opts.pullRequest.prUrl} could not be closed after delivery reconciliation failed. Manual reconciliation is required before retrying.`,
    });
  }

  let canonical: MarkAgentPullRequestClosedResult;
  try {
    canonical = await opts.markCanonicalClosed(closed);
  } catch (err) {
    if (opts.reason.kind === "reconciliation_failed" && !opts.reason.canonicalRecordRequired) {
      return retryableCompensationFailure({
        pullRequest: opts.pullRequest,
        error: opts.reason.error,
      });
    }
    return manualReconciliationFailure({
      pullRequest: opts.pullRequest,
      reason: opts.reason,
      actionRequired: "sync_canonical_state",
      closeError: null,
      canonicalState: null,
      error: `The PR at ${opts.pullRequest.prUrl} was closed, but its canonical record could not be updated (${err instanceof Error ? err.message : String(err)}). Manual reconciliation is required before retrying.`,
    });
  }

  const canonicalMayRemainOpen =
    canonical.canonicalRecordFound && canonical.canonicalState === "open";
  const canonicalWasRequired =
    opts.reason.kind === "incident_not_open" || opts.reason.canonicalRecordRequired === true;
  if (canonicalMayRemainOpen || (canonicalWasRequired && !canonical.canonicalRecordFound)) {
    return manualReconciliationFailure({
      pullRequest: opts.pullRequest,
      reason: opts.reason,
      actionRequired: "sync_canonical_state",
      closeError: null,
      canonicalState: canonical.canonicalState,
      error: `The PR at ${opts.pullRequest.prUrl} was closed, but its canonical state could not be verified. Manual reconciliation is required before retrying.`,
    });
  }

  if (opts.reason.kind === "incident_not_open") {
    return {
      ok: false,
      deliveryStatus: "incident_not_open",
      retryable: false,
      incidentStatus: opts.reason.incidentStatus,
      error: `The incident was already ${opts.reason.incidentStatus ?? "unavailable"}; ${opts.pullRequest.prUrl} was closed and was not delivered.`,
    };
  }
  return retryableCompensationFailure({
    pullRequest: opts.pullRequest,
    error: opts.reason.error,
  });
}

export async function reconcilePullRequestDeliveryAbortClose(opts: {
  close: {
    providerUpdatedAt?: Date;
    loadAuthoritativeObservation?: () => Promise<AgentPullRequestProviderObservation>;
  };
  observedAt: Date;
  applyObservation(
    observation: AgentPullRequestProviderObservation,
  ): Promise<MarkAgentPullRequestClosedResult>;
}): Promise<MarkAgentPullRequestClosedResult> {
  const reconciliation = await reconcileAgentPullRequestProviderObservation(
    {
      targetState: "closed",
      observedAt: opts.observedAt,
      providerUpdatedAt: opts.close.providerUpdatedAt,
      closedAt: opts.close.providerUpdatedAt ?? opts.observedAt,
    },
    {
      applyObservation: opts.applyObservation,
      loadAuthoritativeObservation: async () => {
        if (!opts.close.loadAuthoritativeObservation) {
          throw new Error("authoritative provider state is unavailable for the closed PR");
        }
        return opts.close.loadAuthoritativeObservation();
      },
    },
  );
  return reconciliation.mutation;
}

type ReconcileGithubPullRequestMutationDependencies = {
  findRecordedDelivery: typeof findRecordedPullRequestDelivery;
  compensate: typeof compensateGithubPullRequestMutation;
};

function recoveredDeliveryMatchesMutation(
  delivery: RecordedPullRequestDelivery,
  pullRequest: PullRequestDeliveryCoordinates,
): boolean {
  return (
    delivery.repoFullName === pullRequest.repoFullName &&
    delivery.prNumber === pullRequest.prNumber &&
    delivery.url === pullRequest.prUrl &&
    delivery.branchName === pullRequest.branchName
  );
}

function committedDeliveryInvariantFailure(opts: {
  pullRequest: PullRequestDeliveryCoordinates;
  reconciliationError: string;
  recoveryError: string;
}): ProposedPullRequestCompensationFailure {
  return manualReconciliationFailure({
    pullRequest: opts.pullRequest,
    reason: {
      kind: "reconciliation_failed",
      error: `${opts.reconciliationError}; durable delivery recovery conflicted (${opts.recoveryError})`,
      canonicalRecordRequired: true,
    },
    actionRequired: "sync_canonical_state",
    closeError: null,
    canonicalState: null,
    error: `The durable delivery record for ${opts.pullRequest.prUrl} conflicts with the pull request mutation. No compensating close was attempted; manual reconciliation is required.`,
  });
}

export async function reconcileGithubPullRequestMutation(
  opts: {
    incidentId: string;
    agentRunId: string;
    deliveryIdentity?: PullRequestDeliveryIdentity;
    pullRequest: PullRequestDeliveryCoordinates & { prNodeId: string | null };
    installationId: number;
    fallbackInstallationIds: number[];
    canonicalRecordRequiredOnFailure: boolean;
    reconcile: () => Promise<PullRequestMutationReconciliation>;
  },
  dependencyOverrides: Partial<ReconcileGithubPullRequestMutationDependencies> = {},
): Promise<
  | { ok: true; deliveryReceipt?: PullRequestMutationReconciliation["deliveryReceipt"] }
  | ProposedPullRequestCompensationFailure
> {
  const dependencies: ReconcileGithubPullRequestMutationDependencies = {
    findRecordedDelivery: findRecordedPullRequestDelivery,
    compensate: compensateGithubPullRequestMutation,
    ...dependencyOverrides,
  };
  let reconciliation: PullRequestMutationReconciliation;
  try {
    reconciliation = await opts.reconcile();
  } catch (err) {
    if (opts.deliveryIdentity) {
      let recovered: RecordedPullRequestDelivery | null;
      try {
        recovered = await dependencies.findRecordedDelivery({
          incidentId: opts.incidentId,
          agentRunId: opts.agentRunId,
          identity: opts.deliveryIdentity,
          repoFullName: opts.pullRequest.repoFullName,
        });
      } catch (recoveryError) {
        const reconciliationError = err instanceof Error ? err.message : String(err);
        const recoveryMessage =
          recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
        if (recoveryError instanceof PullRequestDeliveryReceiptConflictError) {
          return committedDeliveryInvariantFailure({
            pullRequest: opts.pullRequest,
            reconciliationError,
            recoveryError: recoveryMessage,
          });
        }
        throw new PullRequestDeliveryRecoveryPendingError(
          `Canonical reconciliation failed (${reconciliationError}) and durable delivery recovery is unavailable (${recoveryMessage}). No compensating close was attempted.`,
          { cause: recoveryError },
        );
      }
      if (recovered) {
        if (!recoveredDeliveryMatchesMutation(recovered, opts.pullRequest)) {
          return committedDeliveryInvariantFailure({
            pullRequest: opts.pullRequest,
            reconciliationError: err instanceof Error ? err.message : String(err),
            recoveryError: "receipt coordinates do not match the pull request mutation",
          });
        }
        return {
          ok: true,
          deliveryReceipt: { newlyRecorded: false, delivery: recovered },
        };
      }
    }
    return dependencies.compensate({
      ...opts,
      reason: {
        kind: "reconciliation_failed",
        error: err instanceof Error ? err.message : String(err),
        canonicalRecordRequired: opts.canonicalRecordRequiredOnFailure,
      },
    });
  }
  if (reconciliation.kind === "deliver") {
    return {
      ok: true,
      ...(reconciliation.deliveryReceipt
        ? { deliveryReceipt: reconciliation.deliveryReceipt }
        : {}),
    };
  }

  const reason: PullRequestDeliveryCompensationReason =
    reconciliation.reason === "incident_not_open"
      ? {
          kind: "incident_not_open",
          incidentStatus: reconciliation.incidentStatus,
        }
      : {
          kind: "reconciliation_failed",
          error: `Canonical PR state is ${reconciliation.canonicalState ?? "missing"}.`,
          canonicalRecordRequired: reconciliation.agentPullRequestId !== null,
        };
  return dependencies.compensate({ ...opts, reason });
}

async function compensateGithubPullRequestMutation(opts: {
  incidentId: string;
  pullRequest: PullRequestDeliveryCoordinates & { prNodeId: string | null };
  installationId: number;
  fallbackInstallationIds: number[];
  reason: PullRequestDeliveryCompensationReason;
}): Promise<ProposedPullRequestCompensationFailure> {
  const { prNodeId, ...pullRequest } = opts.pullRequest;
  return compensatePullRequestDelivery({
    pullRequest,
    reason: opts.reason,
    closePullRequest: () =>
      closeAgentPullRequestOnGithub({
        installationId: opts.installationId,
        fallbackInstallationIds: opts.fallbackInstallationIds,
        repoFullName: pullRequest.repoFullName,
        prNumber: pullRequest.prNumber,
        prNodeId,
      }),
    markCanonicalClosed: async (closed) => {
      return reconcilePullRequestDeliveryAbortClose({
        close: closed,
        observedAt: new Date(),
        applyObservation: (providerObservation) =>
          markAgentPullRequestClosedAfterDeliveryAbort({
            incidentId: opts.incidentId,
            repoFullName: pullRequest.repoFullName,
            prNumber: pullRequest.prNumber,
            reason:
              opts.reason.kind === "incident_not_open"
                ? "incident_not_open"
                : "reconciliation_failed",
            providerObservation,
          }),
      });
    },
  });
}

export type PreparedProposedPullRequest =
  | { kind: "patch"; patch: string }
  | { kind: "recorded"; delivery: RecordedPullRequestDelivery }
  | { kind: "github_recovery" };

export type OverlappingOpenPullRequest = {
  incidentId: string;
  url: string;
  prNumber: number;
  overlappingFiles: string[];
};

function normalizedChangedFiles(files: unknown): string[] {
  if (!Array.isArray(files)) return [];
  return [
    ...new Set(
      files
        .filter((file): file is string => typeof file === "string")
        .map((file) => file.trim())
        .filter(Boolean),
    ),
  ].sort();
}

export function changedFilesFromUnifiedDiff(patch: string): string[] {
  const files: string[] = [];
  for (const line of patch.match(/^diff --git .+$/gm) ?? []) {
    const paths = parseGitDiffHeaderPaths(line);
    if (!paths) continue;
    const [source, target] = paths;
    if (source.startsWith("a/")) files.push(source.slice(2));
    if (target.startsWith("b/")) files.push(target.slice(2));
  }
  for (const match of patch.matchAll(/^(?:rename|copy) (?:from|to) (.+)$/gm)) {
    const path = match[1] ? decodeGitPathToken(match[1]) : null;
    if (path) files.push(path);
  }
  return normalizedChangedFiles(files);
}

function parseGitDiffHeaderPaths(line: string): [string, string] | null {
  const prefix = "diff --git ";
  if (!line.startsWith(prefix)) return null;
  if (line[prefix.length] !== '"') {
    const candidates: [string, string][] = [];
    let boundary = line.indexOf(" b/", prefix.length);
    while (boundary !== -1) {
      candidates.push([line.slice(prefix.length, boundary), line.slice(boundary + 1)]);
      boundary = line.indexOf(" b/", boundary + 1);
    }
    const matching = candidates.filter(
      ([source, target]) => source.startsWith("a/") && source.slice(2) === target.slice(2),
    );
    if (matching.length === 1) return matching[0] ?? null;
    return candidates.length === 1 ? (candidates[0] ?? null) : null;
  }
  const tokens: string[] = [];
  let offset = prefix.length;
  while (tokens.length < 2) {
    while (line[offset] === " ") offset += 1;
    if (offset >= line.length) return null;
    const start = offset;
    if (line[offset] === '"') {
      offset += 1;
      let escaped = false;
      while (offset < line.length) {
        const character = line[offset];
        offset += 1;
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === '"') {
          break;
        }
      }
      if (line[offset - 1] !== '"') return null;
    } else {
      while (offset < line.length && line[offset] !== " ") offset += 1;
    }
    const decoded = decodeGitPathToken(line.slice(start, offset));
    if (decoded === null) return null;
    tokens.push(decoded);
  }
  return tokens as [string, string];
}

function decodeGitPathToken(token: string): string | null {
  if (!token.startsWith('"')) return token;
  if (!token.endsWith('"')) return null;
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  const escapes: Record<string, number> = {
    a: 0x07,
    b: 0x08,
    f: 0x0c,
    n: 0x0a,
    r: 0x0d,
    t: 0x09,
    v: 0x0b,
    "\\": 0x5c,
    '"': 0x22,
  };
  for (let index = 1; index < token.length - 1; index += 1) {
    const character = token[index];
    if (character !== "\\") {
      const codePoint = token.codePointAt(index);
      if (codePoint === undefined) return null;
      bytes.push(...encoder.encode(String.fromCodePoint(codePoint)));
      if (codePoint > 0xffff) index += 1;
      continue;
    }
    const escaped = token[index + 1];
    if (escaped === undefined) return null;
    if (/[0-7]/.test(escaped)) {
      const octal = token.slice(index + 1, index + 4);
      if (!/^[0-7]{3}$/.test(octal)) return null;
      bytes.push(Number.parseInt(octal, 8));
      index += 3;
      continue;
    }
    const byte = escapes[escaped];
    if (byte === undefined) return null;
    bytes.push(byte);
    index += 1;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

export function changedFilesFromAgentRunResult(
  result: unknown,
  repoFullName: string,
  agentRunId: string,
  currentIncidentId: string,
): string[] {
  if (!result || typeof result !== "object") return [];
  const record = result as Record<string, unknown>;
  const proposals = [
    ...(record.pr && typeof record.pr === "object" ? [record.pr] : []),
    ...(Array.isArray(record.prs) ? record.prs : []),
  ];
  const matching = proposals.filter((proposal) => {
    if (!proposal || typeof proposal !== "object") return false;
    const pr = proposal as Record<string, unknown>;
    return (pr.selectedRepoFullName ?? pr.repoFullName) === repoFullName;
  });
  if (proposals.length > 0 && matching.length === 0) {
    logger.error(
      {
        scope: "agent_run.pr_delivery.changed_files",
        current_incident_id: currentIncidentId,
        agent_run_id: agentRunId,
        repo_full_name: repoFullName,
      },
      "agent run PR metadata did not match the canonical pull request repository",
    );
  }
  return normalizedChangedFiles(
    matching.flatMap((proposal) => {
      const pr = proposal as Record<string, unknown>;
      return [
        ...(Array.isArray(pr.changedFiles) ? pr.changedFiles : []),
        ...(typeof pr.patch === "string" ? changedFilesFromUnifiedDiff(pr.patch) : []),
      ];
    }),
  );
}

async function findOverlappingOpenPullRequest(
  input: {
    projectId: string;
    currentIncidentId: string;
    currentIncidentFirstSeen: Date;
    currentIncidentService: string | null;
    repoFullName: string;
    changedFiles: string[];
  },
  database: Pick<DB, "select"> = db,
): Promise<OverlappingOpenPullRequest | null> {
  if (input.changedFiles.length === 0) return null;
  const groupingWindowMs = 15 * 60 * 1000;
  const rows = await database
    .select({
      incidentId: schema.agentPullRequests.incidentId,
      url: schema.agentPullRequests.url,
      prNumber: schema.agentPullRequests.prNumber,
      changedFiles: schema.agentPullRequests.changedFiles,
      agentRunId: schema.agentRuns.id,
      result: schema.agentRuns.result,
    })
    .from(schema.agentPullRequests)
    .innerJoin(schema.agentRuns, eq(schema.agentRuns.id, schema.agentPullRequests.agentRunId))
    .innerJoin(schema.incidents, eq(schema.incidents.id, schema.agentPullRequests.incidentId))
    .where(
      and(
        eq(schema.incidents.projectId, input.projectId),
        ne(schema.agentPullRequests.incidentId, input.currentIncidentId),
        gte(
          schema.incidents.firstSeen,
          new Date(input.currentIncidentFirstSeen.getTime() - groupingWindowMs),
        ),
        lte(
          schema.incidents.firstSeen,
          new Date(input.currentIncidentFirstSeen.getTime() + groupingWindowMs),
        ),
        input.currentIncidentService
          ? or(
              eq(schema.incidents.service, input.currentIncidentService),
              isNull(schema.incidents.service),
            )
          : undefined,
        eq(schema.agentPullRequests.repoFullName, input.repoFullName),
        eq(schema.agentPullRequests.state, "open"),
      ),
    )
    .orderBy(desc(schema.agentPullRequests.createdAt));

  const proposedFiles = new Set(input.changedFiles);
  for (const row of rows) {
    const fallbackFiles = row.changedFiles?.length
      ? []
      : changedFilesFromAgentRunResult(
          row.result,
          input.repoFullName,
          row.agentRunId,
          input.currentIncidentId,
        );
    if (!row.changedFiles?.length && fallbackFiles.length > 0) {
      logger.info(
        {
          scope: "agent_run.pr_delivery.overlap_legacy_fallback",
          current_incident_id: input.currentIncidentId,
          agent_run_id: row.agentRunId,
          repo_full_name: input.repoFullName,
          derived_file_count: fallbackFiles.length,
        },
        "derived changed files from a legacy agent run result during overlap detection",
      );
    }
    const existingFiles = normalizedChangedFiles([...(row.changedFiles ?? []), ...fallbackFiles]);
    const overlappingFiles = existingFiles.filter((file) => proposedFiles.has(file));
    if (overlappingFiles.length > 0) return { ...row, overlappingFiles };
  }
  return null;
}

export type PullRequestOverlapInput = Parameters<typeof findOverlappingOpenPullRequest>[0];

export type PullRequestOverlapGuardDependencies = {
  exclusive<T>(keys: readonly string[], task: () => Promise<T>): Promise<T>;
  findOverlap(input: PullRequestOverlapInput): Promise<OverlappingOpenPullRequest | null>;
};

async function withPullRequestOverlapLocks<T>(
  keys: readonly string[],
  task: () => Promise<T>,
): Promise<T> {
  return withDatabaseAdvisoryLocks(keys, task);
}

const pullRequestOverlapGuardDependencies: PullRequestOverlapGuardDependencies = {
  exclusive: withPullRequestOverlapLocks,
  findOverlap: findOverlappingOpenPullRequest,
};

export async function guardProposedPullRequestOverlap<T>(
  input: PullRequestOverlapInput,
  task: () => Promise<T>,
  dependencies: PullRequestOverlapGuardDependencies = pullRequestOverlapGuardDependencies,
): Promise<{ ok: true; value: T } | { ok: false; overlap: OverlappingOpenPullRequest }> {
  const normalizedFiles = normalizedChangedFiles(input.changedFiles);
  const lockKeys = normalizedFiles.map(
    (file) => `agent-pr-overlap:${input.projectId}:${input.repoFullName}:${file}`,
  );
  if (lockKeys.length === 0) {
    if (input.changedFiles.length > 0) {
      logger.error(
        {
          scope: "agent_run.pr_delivery.overlap_guard_skipped",
          current_incident_id: input.currentIncidentId,
          repo_full_name: input.repoFullName,
          raw_file_count: input.changedFiles.length,
        },
        "overlap guard skipped: changed files present but none survived normalization",
      );
    } else {
      logger.info(
        {
          scope: "agent_run.pr_delivery.overlap_guard_no_files",
          current_incident_id: input.currentIncidentId,
          repo_full_name: input.repoFullName,
        },
        "overlap guard skipped: no changed files provided",
      );
    }
    return { ok: true, value: await task() };
  }
  return dependencies.exclusive(lockKeys, async () => {
    const overlap = await dependencies.findOverlap(input);
    if (overlap) return { ok: false, overlap };
    return { ok: true, value: await task() };
  });
}

function blockedByOverlappingPullRequest(
  ctx: AgentRunContext,
  overlap: OverlappingOpenPullRequest,
): { ok: false; error: string } {
  logger.error(
    {
      scope: "agent_run.pr_delivery.overlap",
      current_incident_id: ctx.incident.id,
      overlapping_incident_id: overlap.incidentId,
      overlapping_pr_url: overlap.url,
      overlapping_files: overlap.overlappingFiles,
    },
    "preflight blocked: nearby incident already has an open PR touching the same files",
  );
  return {
    ok: false,
    error: `Another open incident already has PR ${overlap.url} touching ${overlap.overlappingFiles.join(", ")}. Do not retry this proposal or open a competing PR; treat that PR as the existing remediation and report any additional findings there.`,
  };
}

type ProposedPullRequestPreflightDependencies = {
  findRecordedDelivery: typeof findRecordedPullRequestDelivery;
  listRepositories: typeof listAccessibleGithubRepositories;
  findGithubDelivery: typeof findGithubPullRequestDelivery;
  downloadPatch: typeof downloadAgentPatchFile;
  validatePatch: typeof validateAgentPatchApplicability;
  findOverlappingOpenPullRequest: typeof findOverlappingOpenPullRequest;
  findCurrentOpenPullRequest(input: {
    incidentId: string;
    repoFullName: string;
    branchName: string;
  }): Promise<{ branchName: string } | undefined>;
};

const proposedPullRequestPreflightDependencies: ProposedPullRequestPreflightDependencies = {
  findRecordedDelivery: findRecordedPullRequestDelivery,
  listRepositories: listAccessibleGithubRepositories,
  findGithubDelivery: findGithubPullRequestDelivery,
  downloadPatch: downloadAgentPatchFile,
  validatePatch: validateAgentPatchApplicability,
  findOverlappingOpenPullRequest,
  findCurrentOpenPullRequest: (input) =>
    db.query.agentPullRequests.findFirst({
      where: and(
        eq(schema.agentPullRequests.incidentId, input.incidentId),
        eq(schema.agentPullRequests.repoFullName, input.repoFullName),
        eq(schema.agentPullRequests.branchName, input.branchName),
        eq(schema.agentPullRequests.state, "open"),
      ),
      orderBy: [desc(schema.agentPullRequests.createdAt)],
      columns: { branchName: true },
    }),
};

export async function preflightProposedPullRequest(
  ctx: AgentRunContext,
  pr: {
    repoFullName: string;
    branchName: string;
    baseBranch: string;
    patchFilePath: string;
    changedFiles?: string[];
  },
  sessionId: string,
  deliveryIdentity?: PullRequestDeliveryIdentity,
  dependencyOverrides: Partial<ProposedPullRequestPreflightDependencies> = {},
): Promise<{ ok: true; prepared: PreparedProposedPullRequest } | { ok: false; error: string }> {
  const dependencies = {
    ...proposedPullRequestPreflightDependencies,
    ...dependencyOverrides,
  };
  if (deliveryIdentity) {
    const recorded = await dependencies.findRecordedDelivery({
      incidentId: ctx.incident.id,
      agentRunId: ctx.agentRun.id,
      identity: deliveryIdentity,
      repoFullName: pr.repoFullName,
    });
    if (recorded) return { ok: true, prepared: { kind: "recorded", delivery: recorded } };
  }
  if (ctx.prPolicy === "never") {
    return { ok: false, error: "This organization's policy is do-not-PR." };
  }
  if (ctx.githubInstalls.length === 0) {
    return { ok: false, error: "Cannot open a PR: no GitHub installation is connected." };
  }

  let repoMeta: InstalledGithubRepo | undefined;
  try {
    const repos = await dependencies.listRepositories(ctx);
    repoMeta = repos.find((repo) => repo.fullName === pr.repoFullName);
  } catch (err) {
    return {
      ok: false,
      error: `Cannot validate a PR: GitHub repositories could not be listed (${err instanceof Error ? err.message : String(err)}). Try again.`,
    };
  }
  if (!repoMeta) {
    return {
      ok: false,
      error: `Cannot open a PR: GitHub does not grant access to ${pr.repoFullName}.`,
    };
  }

  let recoveredOnGithub = false;
  if (deliveryIdentity) {
    try {
      const recovered = await dependencies.findGithubDelivery({
        installationId: repoMeta.installation.installationId,
        repositoryId: repoMeta.id,
        repoFullName: pr.repoFullName,
        requestedBranch: pr.branchName,
        baseBranch: (resolvePullRequestBaseBranch(ctx, pr) ?? pr.baseBranch.trim()) || "main",
        deliveryId: deliveryIdentity.deliveryId,
      });
      recoveredOnGithub = recovered !== null;
    } catch (err) {
      return {
        ok: false,
        error: `Cannot recover a prior PR delivery (${err instanceof Error ? err.message : String(err)}). Try again.`,
      };
    }
  }

  let patch: string;
  try {
    patch = (
      await dependencies.downloadPatch({
        sessionId,
        patchFileId: null,
        patchFilePath: pr.patchFilePath,
      })
    ).patch;
  } catch (err) {
    return {
      ok: false,
      error: `Failed to read ${pr.patchFilePath} (${err instanceof Error ? err.message : String(err)}).`,
    };
  }

  const changedFiles = normalizedChangedFiles([
    ...(pr.changedFiles ?? []),
    ...changedFilesFromUnifiedDiff(patch),
  ]);
  pr.changedFiles = changedFiles;
  if (recoveredOnGithub) return { ok: true, prepared: { kind: "github_recovery" } };
  const overlap = await dependencies.findOverlappingOpenPullRequest({
    projectId: ctx.project.id,
    currentIncidentId: ctx.incident.id,
    currentIncidentFirstSeen: ctx.incident.firstSeen,
    currentIncidentService: ctx.incident.service,
    repoFullName: pr.repoFullName,
    changedFiles,
  });
  if (overlap) return blockedByOverlappingPullRequest(ctx, overlap);

  const existingPr = await dependencies.findCurrentOpenPullRequest({
    incidentId: ctx.incident.id,
    repoFullName: pr.repoFullName,
    branchName: pr.branchName,
  });
  try {
    await dependencies.validatePatch({
      installationId: repoMeta.installation.installationId,
      repositoryId: repoMeta.id,
      repoFullName: pr.repoFullName,
      patch,
      baseBranch: resolvePullRequestBaseBranch(ctx, pr),
      existingBranch: existingPr?.branchName ?? null,
    });
  } catch (err) {
    return { ok: false, error: summarizePrOpenFailure(err) };
  }
  return { ok: true, prepared: { kind: "patch", patch } };
}

// Apply the agent's patch and open (or update) a PR before the terminal ack.
// Unlike completeWithPullRequest this NEVER fails the run: every
// failure is returned as a model-readable error so the agent can fix its own
// patch (or pick another branch) and call propose_pr again. PRs are keyed by
// (incident, repo, branch): the same branchName pushes a follow-up commit to
// that PR; a new branchName opens an independent PR.
export type ProposedPullRequestDeliveryDependencies = {
  listRepositories(ctx: AgentRunContext): Promise<InstalledGithubRepo[]>;
  pushPatchToExistingPr: typeof pushPatchToExistingAgentPr;
  guardOverlap: typeof guardProposedPullRequestOverlap;
};

const proposedPullRequestDeliveryDependencies: ProposedPullRequestDeliveryDependencies = {
  listRepositories: listAccessibleGithubRepositories,
  pushPatchToExistingPr: pushPatchToExistingAgentPr,
  guardOverlap: guardProposedPullRequestOverlap,
};

export async function deliverProposedPullRequest(
  ctx: AgentRunContext,
  pr: {
    repoFullName: string;
    title: string;
    body: string;
    branchName: string;
    baseBranch: string;
    patchFilePath: string;
    changedFiles?: string[];
  },
  sessionId: string,
  findings: AgentRunFindings | null,
  prepared?: PreparedProposedPullRequest,
  deliveryIdentity?: PullRequestDeliveryIdentity,
  dependencies: ProposedPullRequestDeliveryDependencies = proposedPullRequestDeliveryDependencies,
): Promise<ProposedPullRequestDeliveryResult> {
  if (prepared?.kind === "recorded") {
    return {
      ok: true,
      url: prepared.delivery.url,
      prNumber: prepared.delivery.prNumber,
      branchName: prepared.delivery.branchName,
      updatedExisting: prepared.delivery.updatedExisting,
    };
  }
  if (ctx.prPolicy === "never") {
    return {
      ok: false,
      error:
        "This organization's policy is do-not-PR. Do not propose patches; record findings, then choose another terminal outcome appropriate to the investigation.",
    };
  }
  if (ctx.githubInstalls.length === 0) {
    return { ok: false, error: "Cannot open a PR: no GitHub installation is connected." };
  }

  let repoMeta: InstalledGithubRepo | undefined;
  try {
    const repos = await dependencies.listRepositories(ctx);
    repoMeta = repos.find((repo) => repo.fullName === pr.repoFullName);
  } catch (err) {
    return {
      ok: false,
      error: `Cannot open a PR: GitHub repositories could not be listed (${err instanceof Error ? err.message : String(err)}). Try again.`,
    };
  }
  if (!repoMeta) {
    return {
      ok: false,
      error: `Cannot open a PR: GitHub does not grant access to ${pr.repoFullName}. Use one of the mounted repositories.`,
    };
  }

  let patch = prepared?.kind === "patch" ? prepared.patch : null;
  if (!patch && prepared?.kind !== "github_recovery") {
    try {
      const downloaded = await downloadAgentPatchFile({
        sessionId,
        patchFileId: null,
        patchFilePath: pr.patchFilePath,
      });
      patch = downloaded.patch;
    } catch (err) {
      return {
        ok: false,
        error: `Failed to read the patch file at ${pr.patchFilePath} (${err instanceof Error ? err.message : String(err)}). Write the unified diff there first, then call propose_pr again.`,
      };
    }
  }
  patch ??= "";
  const changedFiles = normalizedChangedFiles([
    ...(pr.changedFiles ?? []),
    ...changedFilesFromUnifiedDiff(patch),
  ]);
  pr.changedFiles = changedFiles;

  const commitAuthor =
    repoMeta.installation.commitAuthorName && repoMeta.installation.commitAuthorEmail
      ? {
          name: repoMeta.installation.commitAuthorName,
          email: repoMeta.installation.commitAuthorEmail,
        }
      : DEFAULT_COMMIT_AUTHOR;
  const prTitle = buildPrTitle({ ctx, result: { summary: pr.title }, pr });
  const prBody = buildPrBody({
    incidentUrl: buildContextIncidentUrl(WEB_ORIGIN, ctx),
    result: { summary: pr.body },
    pr,
  });
  const ticketResult = assembleAgentRunResult({
    findings: findings ?? { summary: pr.title },
    terminal: null,
    actions: [],
  });

  // Same branch on the same repo for this incident → push a follow-up commit
  // to the existing open PR instead of opening a duplicate.
  const existingPr = await db.query.agentPullRequests.findFirst({
    where: and(
      eq(schema.agentPullRequests.incidentId, ctx.incident.id),
      eq(schema.agentPullRequests.repoFullName, pr.repoFullName),
      eq(schema.agentPullRequests.branchName, pr.branchName),
      eq(schema.agentPullRequests.state, "open"),
    ),
    orderBy: [desc(schema.agentPullRequests.createdAt)],
  });
  if (existingPr) {
    const guardedUpdate = await dependencies.guardOverlap(
      {
        projectId: ctx.project.id,
        currentIncidentId: ctx.incident.id,
        currentIncidentFirstSeen: ctx.incident.firstSeen,
        currentIncidentService: ctx.incident.service,
        repoFullName: pr.repoFullName,
        changedFiles,
      },
      async () => {
        let pushed: { headSha: string };
        try {
          pushed = await dependencies.pushPatchToExistingPr({
            installationId: repoMeta.installation.installationId,
            repositoryId: repoMeta.id,
            repoFullName: pr.repoFullName,
            patch,
            branchName: existingPr.branchName,
            prNumber: existingPr.prNumber,
            commitTitle: prTitle,
            commentBody: pr.body,
            commitAuthor,
            ...(deliveryIdentity ? { deliveryId: deliveryIdentity.deliveryId } : {}),
          });
        } catch (err) {
          return { kind: "push_failed" as const, error: summarizePrOpenFailure(err) };
        }
        const reconciled = await reconcileGithubPullRequestMutation({
          incidentId: ctx.incident.id,
          agentRunId: ctx.agentRun.id,
          ...(deliveryIdentity ? { deliveryIdentity } : {}),
          pullRequest: {
            repoFullName: existingPr.repoFullName,
            branchName: existingPr.branchName,
            prUrl: existingPr.url,
            prNumber: existingPr.prNumber,
            prNodeId: existingPr.prNodeId,
          },
          installationId: repoMeta.installation.installationId,
          fallbackInstallationIds: ctx.githubInstalls.map(
            ({ installation }) => installation.installationId,
          ),
          canonicalRecordRequiredOnFailure: true,
          reconcile: () =>
            recordUpdatedAgentPullRequest({
              incidentId: ctx.incident.id,
              agentRunId: ctx.agentRun.id,
              agentPullRequestId: existingPr.id,
              repoFullName: existingPr.repoFullName,
              prNumber: existingPr.prNumber,
              headSha: pushed.headSha,
              changedFiles,
              url: existingPr.url,
              branchName: existingPr.branchName,
              ...(deliveryIdentity ? { deliveryIdentity } : {}),
            }),
        });
        return { kind: "updated" as const, reconciled };
      },
    );
    if (!guardedUpdate.ok) return blockedByOverlappingPullRequest(ctx, guardedUpdate.overlap);
    if (guardedUpdate.value.kind === "push_failed") {
      return { ok: false, error: guardedUpdate.value.error };
    }
    const { reconciled } = guardedUpdate.value;
    if (!reconciled.ok) return reconciled;
    if (!deliveryIdentity || reconciled.deliveryReceipt?.newlyRecorded !== false) {
      await publishPullRequestUpdateIfCurrent(ctx, "running", async () => {
        const linearTicket = await deliverAndRecordLinearTicket(ctx, ticketResult, existingPr.url);
        const ticketLine = linearTicket ? `\n${linearTicketSlackReference(linearTicket)}` : "";
        await postIncidentThreadMessage(
          ctx.incident.id,
          `:arrows_counterclockwise: Pushed an update to PR ${existingPr.url}${ticketLine}`,
        ).catch(() => {});
      });
    }
    const delivered = reconciled.deliveryReceipt?.delivery;
    return {
      ok: true,
      url: delivered?.url ?? existingPr.url,
      prNumber: delivered?.prNumber ?? existingPr.prNumber,
      branchName: delivered?.branchName ?? existingPr.branchName,
      updatedExisting: delivered?.updatedExisting ?? true,
    };
  }

  const guarded = await dependencies.guardOverlap(
    {
      projectId: ctx.project.id,
      currentIncidentId: ctx.incident.id,
      currentIncidentFirstSeen: ctx.incident.firstSeen,
      currentIncidentService: ctx.incident.service,
      repoFullName: pr.repoFullName,
      changedFiles,
    },
    async () => {
      let opened: Awaited<ReturnType<typeof openAgentRunPullRequest>>;
      try {
        opened = await openAgentRunPullRequest({
          installationId: repoMeta.installation.installationId,
          repositoryId: repoMeta.id,
          repoFullName: pr.repoFullName,
          patch,
          branchName: pr.branchName,
          baseBranch: resolvePullRequestBaseBranch(ctx, pr),
          title: prTitle,
          body: prBody,
          commitAuthor,
          ...(deliveryIdentity ? { deliveryId: deliveryIdentity.deliveryId } : {}),
        });
      } catch (err) {
        return { kind: "open_failed" as const, error: summarizePrOpenFailure(err) };
      }

      // Keep the overlap locks until the provider mutation is durable. A
      // concurrent proposal touching any of the same files waits, then sees
      // this row instead of opening a competing PR.
      const reconciled = await reconcileGithubPullRequestMutation({
        incidentId: ctx.incident.id,
        agentRunId: ctx.agentRun.id,
        ...(deliveryIdentity ? { deliveryIdentity } : {}),
        pullRequest: {
          repoFullName: pr.repoFullName,
          branchName: opened.branchName,
          prUrl: opened.prUrl,
          prNumber: opened.prNumber,
          prNodeId: opened.prNodeId,
        },
        installationId: repoMeta.installation.installationId,
        fallbackInstallationIds: ctx.githubInstalls.map(
          ({ installation }) => installation.installationId,
        ),
        canonicalRecordRequiredOnFailure: false,
        reconcile: () =>
          recordOpenedAgentPullRequest({
            incidentId: ctx.incident.id,
            agentRunId: ctx.agentRun.id,
            installationRowId: repoMeta.installation.id,
            repoFullName: pr.repoFullName,
            prNumber: opened.prNumber,
            prNodeId: opened.prNodeId,
            url: opened.prUrl,
            branchName: opened.branchName,
            baseBranch: opened.baseBranch,
            headSha: opened.headSha,
            changedFiles,
            title: prTitle,
            authorLogin: opened.authorLogin,
            authorGithubId: opened.authorGithubId,
            authorAvatarUrl: opened.authorAvatarUrl,
            state: opened.state,
            mergedAt: opened.mergedAt,
            ...(deliveryIdentity ? { deliveryIdentity } : {}),
          }),
      });
      return { kind: "delivered" as const, opened, reconciled };
    },
  );
  if (!guarded.ok) return blockedByOverlappingPullRequest(ctx, guarded.overlap);
  if (guarded.value.kind === "open_failed") return { ok: false, error: guarded.value.error };
  const { opened, reconciled } = guarded.value;
  if (!reconciled.ok) {
    logger.error(
      {
        scope: "agent_run.pr_delivery",
        agent_run_id: ctx.agentRun.id,
        incident_id: ctx.incident.id,
        pr_url: opened.prUrl,
        delivery_status: reconciled.deliveryStatus,
        manual_reconciliation: reconciled.manualReconciliation ?? null,
      },
      "opened agent pull request did not survive delivery reconciliation",
    );
    return reconciled;
  }
  const shouldPublishDelivery =
    !deliveryIdentity || reconciled.deliveryReceipt?.newlyRecorded !== false;
  if (shouldPublishDelivery) {
    await publishPullRequestUpdateIfCurrent(ctx, "running", async () => {
      await agentRunLifecycle.appendAgentEvent({
        agentRunId: ctx.agentRun.id,
        kind: "pr_opened",
        summary: `Opened PR: ${opened.prUrl}`,
        providerEventId: `pr_opened:${opened.prUrl}`,
        detail: { url: opened.prUrl },
      });

      // The first successfully-recorded PR is the ticket creation boundary.
      // Later PRs reuse the run-scoped ticket, then independently cross-link
      // in both directions.
      const linearTicket = await deliverAndRecordLinearTicket(ctx, ticketResult, opened.prUrl);

      if (
        ctx.autoMergeFixPrs !== "never" &&
        (await agentRunLifecycle.canPublishStatusUpdate({
          id: ctx.agentRun.id,
          incidentId: ctx.incident.id,
          state: "running",
        }))
      ) {
        try {
          const outcome = await mergeAgentPullRequest({
            installationId: repoMeta.installation.installationId,
            repositoryId: repoMeta.id,
            repoFullName: pr.repoFullName,
            prNumber: opened.prNumber,
            prNodeId: opened.prNodeId,
            policy: ctx.autoMergeFixPrs,
            method: ctx.autoMergeMethod,
          });
          const note =
            outcome.kind === "merged"
              ? `:white_check_mark: Auto-merged PR (${ctx.autoMergeMethod})`
              : outcome.kind === "auto_merge_enabled"
                ? `:hourglass_flowing_sand: Auto-merge enabled — will land once checks pass (${ctx.autoMergeMethod})`
                : null;
          if (note) {
            const ticketLine = linearTicket ? `\n${linearTicketSlackReference(linearTicket)}` : "";
            await postIncidentThreadMessage(ctx.incident.id, `${note}${ticketLine}`).catch(
              () => {},
            );
          }
        } catch (err) {
          logger.warn(
            {
              scope: "agent_run.pr_delivery.auto_merge",
              agent_run_id: ctx.agentRun.id,
              incident_id: ctx.incident.id,
              pr_url: opened.prUrl,
              err: err instanceof Error ? err.message : String(err),
            },
            "auto-merge attempt failed; leaving PR open for human merge",
          );
        }
      }

      const ticketLine = linearTicket ? `\n${linearTicketSlackReference(linearTicket)}` : "";
      await postIncidentThreadMessage(
        ctx.incident.id,
        `:bulb: Opened PR ${opened.prUrl}${ticketLine}`,
      ).catch(() => {});
      const incidentUrl = buildContextIncidentUrl(WEB_ORIGIN, ctx);
      await updateIncidentMainMessage(
        ctx.incident.id,
        `:bulb: PR Ready: ${ctx.incident.title}`,
        incidentBlocks({
          emoji: "bulb",
          status: "PR Ready",
          title: ctx.incident.title,
          tagline: pr.title,
          service: ctx.incident.service,
          buttons: [
            { text: "Open in Superlog", url: incidentUrl, actionId: "open_superlog" },
            { text: "View PR", url: opened.prUrl, actionId: "view_pr" },
            ...(linearTicket?.url
              ? [
                  {
                    text: `View ${linearTicket.identifier}`,
                    url: linearTicket.url,
                    actionId: "view_linear",
                  },
                ]
              : []),
          ],
          incidentId: ctx.incident.id,
          showResolveButton: true,
          showMergePrButton: true,
        }),
      ).catch(() => {});
    });
  }

  const delivered = reconciled.deliveryReceipt?.delivery;
  return {
    ok: true,
    url: delivered?.url ?? opened.prUrl,
    prNumber: delivered?.prNumber ?? opened.prNumber,
    branchName: delivered?.branchName ?? opened.branchName,
    updatedExisting: delivered?.updatedExisting ?? false,
  };
}

export async function retryQueuedPullRequestDelivery(ctx: AgentRunContext): Promise<void> {
  const result = ctx.agentRun.result;
  const pr = result?.pr ?? null;
  if (!result || !pr) {
    await failAgentRun(
      ctx,
      "pr_open_failed",
      "Cannot retry PR delivery because the failed run has no PR result.",
      { existingResult: result ?? null },
    );
    return;
  }

  const started = await agentRunLifecycle.startPrRetry({
    id: ctx.agentRun.id,
    incidentId: ctx.incident.id,
    currentState: ctx.agentRun.state,
  });
  if (!started) return;

  ctx.agentRun = {
    ...ctx.agentRun,
    state: "running",
    failureReason: null,
    completedAt: null,
    updatedAt: new Date(),
  };

  await completeWithPullRequest(
    ctx,
    { ...result, summary: ctx.incident.agentSummary ?? result.summary },
    pr,
    ctx.agentRun.providerSessionId ?? "",
    ctx.agentRun.cumulativeRuntimeMinutes,
  );
}
