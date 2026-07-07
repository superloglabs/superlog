import {
  type AgentRunResult,
  createIncidentLifecycle,
  db,
  normalizePrBaseBranch,
  schema,
} from "@superlog/db";
import { and, desc, eq } from "drizzle-orm";
import {
  type AgentRunContext,
  type InstalledGithubRepo,
  listAccessibleGithubRepositories,
} from "../agent-run-context.js";
import { createAgentRunLifecycle } from "../agent-run.js";
import { mergeAgentPullRequest, pushPatchToExistingAgentPr } from "../github-app.js";
import { downloadAgentPatchFile } from "../infra/agent-runner/patch-files.js";
import { openAgentRunPullRequest } from "../infra/github/pull-requests.js";
import {
  incidentBlocks,
  postIncidentThreadMessage,
  updateIncidentMainMessage,
} from "../infra/slack/incident-messages.js";
import { logger } from "../logger.js";
import { enqueueAgentRunCompleted } from "../webhooks.js";
import { recordFiledLinearTicket, recordOpenedAgentPullRequest } from "./deliverable-records.js";
import { deliverLinearTicket } from "./linear-delivery.js";
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

// Files/updates the incident's Linear ticket from the run result (platform-
// side, deterministic) and records it. Best-effort: PR delivery never fails
// on ticket problems.
async function deliverAndRecordLinearTicket(
  ctx: AgentRunContext,
  result: AgentRunResult,
  prUrl: string,
): Promise<void> {
  try {
    const ticket = await deliverLinearTicket(ctx, result, { prUrl });
    if (ticket) {
      await recordFiledLinearTicket(ctx, {
        id: ticket.id,
        url: ticket.url,
        createdByAgent: ticket.created,
      });
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
}

async function notifyFollowUpPrUpdated(ctx: AgentRunContext, prUrl: string): Promise<void> {
  await postIncidentThreadMessage(
    ctx.incident.id,
    `:arrows_counterclockwise: Follow-up investigation pushed an update to the existing PR: ${prUrl}`,
  );
}

export function resolvePullRequestBaseBranch(
  ctx: Pick<AgentRunContext, "prBaseBranch">,
  pr: Pick<schema.AgentRunPr, "baseBranch">,
): string | null {
  return normalizePrBaseBranch(ctx.prBaseBranch) ?? normalizePrBaseBranch(pr.baseBranch);
}

export async function completeWithPullRequest(
  ctx: AgentRunContext,
  result: AgentRunResult,
  pr: schema.AgentRunPr,
  sessionId: string,
  runtimeMinutes: number,
): Promise<void> {
  if (ctx.githubInstalls.length === 0) {
    await failAgentRun(ctx, "pr_open_failed", "Cannot open a PR without a GitHub installation.", {
      existingResult: result,
    });
    return;
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
    return;
  }
  if (!repoMeta) {
    await failAgentRun(
      ctx,
      "pr_open_failed",
      `Cannot open a PR because GitHub no longer grants access to ${pr.selectedRepoFullName}.`,
      { existingResult: result },
    );
    return;
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
      return;
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
    return;
  }

  const prTitle = buildPrTitle({ ctx, result, pr });
  const prBody = buildPrBody({
    incidentUrl: `${WEB_ORIGIN}/incidents/${ctx.incident.id}`,
    result,
    pr,
  });
  // Persist the resolved patch onto the result we hand to failAgentRun, so a
  // later "retry PR" can re-attempt delivery from the patch on record without
  // depending on the agent session (which may have expired) to re-download it.
  const resultWithPatch: AgentRunResult = { ...result, pr: { ...pr, patch, patchFileId } };

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
        });
      } catch (err) {
        await failAgentRun(ctx, "pr_open_failed", summarizePrOpenFailure(err), {
          existingResult: resultWithPatch,
          err,
        });
        return;
      }

      const now = new Date();
      await db
        .update(schema.agentPullRequests)
        .set({ headSha: pushed.headSha, lastSyncedAt: now, updatedAt: now })
        .where(eq(schema.agentPullRequests.id, existingPr.id));

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
      await agentRunLifecycle.completeWithPullRequest({
        id: ctx.agentRun.id,
        currentState: ctx.agentRun.state,
        result: followUpResult,
        selectedRepoFullName: pr.selectedRepoFullName,
        selectedBaseBranch: existingPr.baseBranch,
        prUrl: existingPr.url,
      });
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
      await deliverAndRecordLinearTicket(ctx, result, existingPr.url);
      await notifyFollowUpPrUpdated(ctx, existingPr.url).catch((err) =>
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
      return;
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
    });
  } catch (err) {
    await failAgentRun(ctx, "pr_open_failed", summarizePrOpenFailure(err), {
      existingResult: resultWithPatch,
      err,
    });
    return;
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
  await agentRunLifecycle.completeWithPullRequest({
    id: ctx.agentRun.id,
    currentState: ctx.agentRun.state,
    result: updatedResult,
    selectedRepoFullName: pr.selectedRepoFullName,
    selectedBaseBranch: opened.baseBranch,
    prUrl: opened.prUrl,
  });
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
  await recordOpenedAgentPullRequest({
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
  }).catch((err) =>
    logger.error(
      {
        scope: "agent_run.pr_delivery",
        agent_run_id: ctx.agentRun.id,
        incident_id: ctx.incident.id,
        pr_url: opened.prUrl,
        err: err instanceof Error ? err.message : String(err),
      },
      "failed to record opened agent pull request",
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
  await deliverAndRecordLinearTicket(ctx, result, opened.prUrl);
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
  await postIncidentThreadMessage(ctx.incident.id, `:bulb: Opened PR ${opened.prUrl}`).catch(
    (err) =>
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
  const incidentUrl = `${WEB_ORIGIN}/incidents/${ctx.incident.id}`;
  await updateIncidentMainMessage(
    ctx.incident.id,
    `:bulb: PR Ready: ${ctx.incident.title}`,
    incidentBlocks({
      emoji: "bulb",
      status: "PR Ready",
      title: ctx.incident.title,
      tagline: result.summary || undefined,
      projectName: ctx.project.name,
      service: ctx.incident.service,
      buttons: [
        { text: "Open in Superlog", url: incidentUrl, actionId: "open_superlog" },
        { text: "View PR", url: opened.prUrl, actionId: "view_pr" },
      ],
      incidentId: ctx.incident.id,
      showResolveButton: true,
      showMergePrButton: true,
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
