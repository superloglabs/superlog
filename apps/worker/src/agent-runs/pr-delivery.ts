import {
  type AgentRunResult,
  createIncidentLifecycle,
  db,
  normalizePrBaseBranch,
  schema,
} from "@superlog/db";
import { and, desc, eq } from "drizzle-orm";
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
import { buildPrBody, buildPrTitle } from "./pr-copy.js";
import { summarizePrOpenFailure } from "./pr-open-failure.js";
import { failAgentRun } from "./status.js";

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:5173";
const DEFAULT_COMMIT_AUTHOR = {
  name: "Superlog app",
  email: "bot@superlog.sh",
};
const agentRunLifecycle = createAgentRunLifecycle(db);
const incidentLifecycle = createIncidentLifecycle(db);

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
  return {
    // The provider marker must survive retries of the same durable run and
    // repository, even when two pollers reach delivery concurrently.
    deliveryId: outcomeActionInputHash({
      scope: "legacy_pull_request_delivery",
      agentRunId: args.agentRunId,
      repoFullName: args.repoFullName,
    }),
    inputHash: outcomeActionInputHash(args.input),
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
        await failAgentRun(ctx, "pr_open_failed", summarizePrOpenFailure(err), {
          existingResult: resultWithPatch,
          err,
        });
        return false;
      }

      const reconciled = await reconcileGithubPullRequestMutation({
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
            url: existingPr.url,
            branchName: existingPr.branchName,
            deliveryIdentity,
          }),
      });
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
      return true;
    }
    // No open PR to land on (closed meanwhile, or the prior run never opened
    // one) — fall through to the normal open-a-new-PR path.
  }
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
    await failAgentRun(ctx, "pr_open_failed", summarizePrOpenFailure(err), {
      existingResult: resultWithPatch,
      err,
    });
    return false;
  }

  const reconciled = await reconcileGithubPullRequestMutation({
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
        title: prTitle,
        authorLogin: opened.authorLogin,
        authorGithubId: opened.authorGithubId,
        authorAvatarUrl: opened.authorAvatarUrl,
        state: opened.state,
        mergedAt: opened.mergedAt,
        deliveryIdentity,
      }),
  });
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
  if (ctx.autoMergeFixPrs !== "never") {
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
      projectName: ctx.project.name,
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

export async function compensatePullRequestDelivery(opts: {
  pullRequest: PullRequestDeliveryCoordinates;
  reason: PullRequestDeliveryCompensationReason;
  closePullRequest: () => Promise<{ ok: true } | { ok: false; error: string }>;
  markCanonicalClosed: () => Promise<MarkAgentPullRequestClosedResult>;
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
    canonical = await opts.markCanonicalClosed();
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

async function reconcileGithubPullRequestMutation(opts: {
  pullRequest: PullRequestDeliveryCoordinates & { prNodeId: string | null };
  installationId: number;
  fallbackInstallationIds: number[];
  canonicalRecordRequiredOnFailure: boolean;
  reconcile: () => Promise<PullRequestMutationReconciliation>;
}): Promise<
  | { ok: true; deliveryReceipt?: PullRequestMutationReconciliation["deliveryReceipt"] }
  | ProposedPullRequestCompensationFailure
> {
  let reconciliation: PullRequestMutationReconciliation;
  try {
    reconciliation = await opts.reconcile();
  } catch (err) {
    return compensateGithubPullRequestMutation({
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
  return compensateGithubPullRequestMutation({ ...opts, reason });
}

async function compensateGithubPullRequestMutation(opts: {
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
    markCanonicalClosed: () =>
      markAgentPullRequestClosedAfterDeliveryAbort({
        repoFullName: pullRequest.repoFullName,
        prNumber: pullRequest.prNumber,
        reason:
          opts.reason.kind === "incident_not_open" ? "incident_not_open" : "reconciliation_failed",
      }),
  });
}

export type PreparedProposedPullRequest =
  | { kind: "patch"; patch: string }
  | { kind: "recorded"; delivery: RecordedPullRequestDelivery }
  | { kind: "github_recovery" };

type ProposedPullRequestPreflightDependencies = {
  findRecordedDelivery: typeof findRecordedPullRequestDelivery;
  listRepositories: typeof listAccessibleGithubRepositories;
  findGithubDelivery: typeof findGithubPullRequestDelivery;
  downloadPatch: typeof downloadAgentPatchFile;
  validatePatch: typeof validateAgentPatchApplicability;
};

const proposedPullRequestPreflightDependencies: ProposedPullRequestPreflightDependencies = {
  findRecordedDelivery: findRecordedPullRequestDelivery,
  listRepositories: listAccessibleGithubRepositories,
  findGithubDelivery: findGithubPullRequestDelivery,
  downloadPatch: downloadAgentPatchFile,
  validatePatch: validateAgentPatchApplicability,
};

export async function preflightProposedPullRequest(
  ctx: AgentRunContext,
  pr: {
    repoFullName: string;
    branchName: string;
    baseBranch: string;
    patchFilePath: string;
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
      if (recovered) return { ok: true, prepared: { kind: "github_recovery" } };
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

  const existingPr = await db.query.agentPullRequests.findFirst({
    where: and(
      eq(schema.agentPullRequests.incidentId, ctx.incident.id),
      eq(schema.agentPullRequests.repoFullName, pr.repoFullName),
      eq(schema.agentPullRequests.branchName, pr.branchName),
      eq(schema.agentPullRequests.state, "open"),
    ),
    orderBy: [desc(schema.agentPullRequests.createdAt)],
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
export async function deliverProposedPullRequest(
  ctx: AgentRunContext,
  pr: {
    repoFullName: string;
    title: string;
    body: string;
    branchName: string;
    baseBranch: string;
    patchFilePath: string;
  },
  sessionId: string,
  findings: AgentRunFindings | null,
  prepared?: PreparedProposedPullRequest,
  deliveryIdentity?: PullRequestDeliveryIdentity,
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
    const repos = await listAccessibleGithubRepositories(ctx);
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
    let pushed: { headSha: string };
    try {
      pushed = await pushPatchToExistingAgentPr({
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
      return { ok: false, error: summarizePrOpenFailure(err) };
    }
    const reconciled = await reconcileGithubPullRequestMutation({
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
          url: existingPr.url,
          branchName: existingPr.branchName,
          ...(deliveryIdentity ? { deliveryIdentity } : {}),
        }),
    });
    if (!reconciled.ok) return reconciled;
    if (!deliveryIdentity || reconciled.deliveryReceipt?.newlyRecorded !== false) {
      const linearTicket = await deliverAndRecordLinearTicket(ctx, ticketResult, existingPr.url);
      const ticketLine = linearTicket ? `\n${linearTicketSlackReference(linearTicket)}` : "";
      await postIncidentThreadMessage(
        ctx.incident.id,
        `:arrows_counterclockwise: Pushed an update to PR ${existingPr.url}${ticketLine}`,
      ).catch(() => {});
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
    return { ok: false, error: summarizePrOpenFailure(err) };
  }

  // The agent_pull_requests row is what the awaiting_events park, the PR
  // webhooks, and same-branch follow-up pushes key on — an unrecorded PR is
  // invisible to all of them, so recording must succeed before the tool can
  // report success.
  const reconciled = await reconcileGithubPullRequestMutation({
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
        title: prTitle,
        authorLogin: opened.authorLogin,
        authorGithubId: opened.authorGithubId,
        authorAvatarUrl: opened.authorAvatarUrl,
        state: opened.state,
        mergedAt: opened.mergedAt,
        ...(deliveryIdentity ? { deliveryIdentity } : {}),
      }),
  });
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
    await agentRunLifecycle.appendAgentEvent({
      agentRunId: ctx.agentRun.id,
      kind: "pr_opened",
      summary: `Opened PR: ${opened.prUrl}`,
      providerEventId: `pr_opened:${opened.prUrl}`,
      detail: { url: opened.prUrl },
    });
  }

  // The first successfully-recorded PR is the ticket creation boundary.
  // Later PRs reuse the run-scoped ticket, then independently cross-link in
  // both directions.
  const linearTicket = shouldPublishDelivery
    ? await deliverAndRecordLinearTicket(ctx, ticketResult, opened.prUrl)
    : null;

  if (shouldPublishDelivery && ctx.autoMergeFixPrs !== "never") {
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
        await postIncidentThreadMessage(ctx.incident.id, `${note}${ticketLine}`).catch(() => {});
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

  if (shouldPublishDelivery) {
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
        projectName: ctx.project.name,
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

  await agentRunLifecycle.startPrRetry({
    id: ctx.agentRun.id,
    currentState: ctx.agentRun.state,
  });

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
