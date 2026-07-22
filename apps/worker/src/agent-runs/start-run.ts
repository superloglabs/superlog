import { db, enqueueAgentRunStarted } from "@superlog/db";
import type { AgentRunContext } from "../agent-run-context.js";
import { listAccessibleGithubRepositories, scoreRepos } from "../agent-run-context.js";
import { createAgentRunLifecycle } from "../agent-run.js";
import { buildContextIncidentUrl } from "../incident-route.js";
import { getAgentRunnerBackend } from "../infra/agent-runner/backend.js";
import {
  createRepositoryReadToken,
  listRepositoryInstructionFiles,
} from "../infra/github/repositories.js";
import {
  incidentBlocks,
  postIncidentThreadMessage,
  updateIncidentMainMessage,
} from "../infra/slack/incident-messages.js";
import { logger } from "../logger.js";
import { buildIssueSummaryWithTrace } from "./prompt-context.js";
import { startQueuedAgentRunWorkflow } from "./start.js";
import {
  failAgentRun,
  moveAgentRunToAwaitingHuman,
  moveAgentRunToBlockedNoGithub,
} from "./status.js";

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:5173";
const agentRunLifecycle = createAgentRunLifecycle(db);

export async function startQueuedAgentRun(ctx: AgentRunContext): Promise<void> {
  await startQueuedAgentRunWorkflow(ctx, {
    lifecycle: agentRunLifecycle,
    getRunnerBackend: getAgentRunnerBackend,
    listRepositories: (ctx) =>
      listAccessibleGithubRepositories(ctx, { toleratePartialFailure: true }),
    scoreRepositories: scoreRepos,
    createRepositoryReadToken,
    listRepositoryInstructionFiles,
    buildIssueSummaries: (ctx) =>
      Promise.all(ctx.issueRows.map((issue) => buildIssueSummaryWithTrace(ctx.project.id, issue))),
    fail: failAgentRun,
    blockForGithub: moveAgentRunToBlockedNoGithub,
    pauseForRepositorySelection: moveAgentRunToAwaitingHuman,
    notifyStarted: notifyAgentRunStarted,
  });
}

async function notifyAgentRunStarted(
  ctx: AgentRunContext,
  repoCandidateCount: number,
): Promise<void> {
  await enqueueAgentRunStarted(ctx.agentRun.id).catch((err) =>
    logger.error(
      {
        scope: "webhooks.enqueue",
        agent_run_id: ctx.agentRun.id,
        err: err instanceof Error ? err.message : String(err),
      },
      "failed to enqueue incident.updated webhook (agent_started)",
    ),
  );
  await postIncidentThreadMessage(
    ctx.incident.id,
    `:mag: Investigation started across ${repoCandidateCount} candidate repos.`,
  );
  const incidentUrl = buildContextIncidentUrl(WEB_ORIGIN, ctx);
  await updateIncidentMainMessage(
    ctx.incident.id,
    `:rotating_light: ${ctx.incident.title} — Investigation ongoing`,
    incidentBlocks({
      emoji: "rotating_light",
      status: "Investigation ongoing",
      title: ctx.incident.title,
      incidentCodename: ctx.incident.codename,
      service: ctx.incident.service,
      buttons: [{ text: "View incident", url: incidentUrl, actionId: "view_incident" }],
      incidentId: ctx.incident.id,
      showResolveButton: true,
    }),
  );
}
