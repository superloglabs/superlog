import { type AgentRunResult, createIncidentLifecycle, db, type schema } from "@superlog/db";
import { eq } from "drizzle-orm";
import {
  type AgentRunContext,
  type InstalledGithubRepo,
  listAccessibleGithubRepositories,
} from "../agent-run-context.js";
import { createAgentRunLifecycle } from "../agent-run.js";
import { mergeAgentPullRequest } from "../github-app.js";
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
  let opened: Awaited<ReturnType<typeof openAgentRunPullRequest>>;
  try {
    opened = await openAgentRunPullRequest({
      installationId: repoMeta.installation.installationId,
      repositoryId: repoMeta.id,
      repoFullName: pr.selectedRepoFullName,
      patch,
      branchName,
      baseBranch: pr.baseBranch,
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
  await recordFiledLinearTicket(ctx, result.linearTicket).catch((err) =>
    logger.error(
      {
        scope: "agent_run.pr_delivery",
        agent_run_id: ctx.agentRun.id,
        incident_id: ctx.incident.id,
        err: err instanceof Error ? err.message : String(err),
      },
      "failed to record filed Linear ticket",
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
