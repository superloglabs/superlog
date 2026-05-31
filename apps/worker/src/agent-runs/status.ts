import { type AgentRunResult, db, schema } from "@superlog/db";
import type { AgentRunContext } from "../agent-run-context.js";
import { createAgentRunLifecycle } from "../agent-run.js";
import {
  incidentBlocks,
  postIncidentThreadMessage,
  updateIncidentMainMessage,
} from "../infra/slack/incident-messages.js";
import { logger } from "../logger.js";

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:5173";
const agentRunLifecycle = createAgentRunLifecycle(db);

// How much wall-clock slack we give a run beyond its provider-active budget
// before we give up. The provider-side budget (snapshot.activeSeconds) is the
// primary check, but Anthropic reports `active_seconds: null` for idle
// sessions, so it never trips for runs that go idle waiting on an
// unacknowledged custom_tool_use. Wall-clock catches those.
export const WALL_CLOCK_MULTIPLIER = 4;

export function exceededWallClockBudget(opts: {
  startedAt: Date | null;
  now: Date;
  maxRuntimeMinutes: number;
}): boolean {
  if (!opts.startedAt) return false;
  const ageMs = opts.now.getTime() - opts.startedAt.getTime();
  const budgetMs = WALL_CLOCK_MULTIPLIER * opts.maxRuntimeMinutes * 60_000;
  return ageMs > budgetMs;
}

const TRANSIENT_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ENOTFOUND",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EPIPE",
  "EHOSTUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

export function isTransientError(err: unknown, seen = new WeakSet<object>()): boolean {
  if (!err || typeof err !== "object") return false;
  if (seen.has(err)) return false;
  seen.add(err);
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_ERROR_CODES.has(code)) return true;
  const cause = (err as { cause?: unknown }).cause;
  if (cause && isTransientError(cause, seen)) return true;
  return false;
}

const MAX_ERROR_LOG_MESSAGE_LENGTH = 500;

export function agentRunErrorLogMeta(err: unknown): Record<string, string> | null {
  if (!err || typeof err !== "object") return null;
  const meta: Record<string, string> = {};
  if (err instanceof Error && err.name) meta.name = err.name;
  if (err instanceof Error && err.message) {
    meta.message = err.message.slice(0, MAX_ERROR_LOG_MESSAGE_LENGTH);
  }
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && /^[A-Z0-9_-]{1,64}$/i.test(code)) meta.code = code;
  return Object.keys(meta).length > 0 ? meta : null;
}

export async function failAgentRun(
  ctx: AgentRunContext,
  reason: schema.AgentRunFailureReason,
  summary: string,
  detail?: { existingResult?: AgentRunResult | null; err?: unknown },
): Promise<void> {
  const category = schema.agentRunFailureCategory(reason);
  logger.error(
    {
      error: agentRunErrorLogMeta(detail?.err),
      scope: "agent_run",
      agent_run_id: ctx.agentRun.id,
      incident_id: ctx.incident.id,
      project_id: ctx.project.id,
      org_id: ctx.project.orgId,
      provider_session_id: ctx.agentRun.providerSessionId,
      from_state: ctx.agentRun.state,
      reason,
      category,
      runtime_minutes: ctx.agentRun.cumulativeRuntimeMinutes,
      resume_count: ctx.agentRun.resumeCount,
    },
    "agent run failed",
  );
  await agentRunLifecycle.fail({
    id: ctx.agentRun.id,
    currentState: ctx.agentRun.state,
    reason,
    summary,
    category,
    existingResult: detail?.existingResult ?? null,
  });
  const emoji =
    category === "agent" ? ":mag:" : category === "deliverable" ? ":x:" : ":rotating_light:";
  await postIncidentThreadMessage(ctx.incident.id, `${emoji} ${summary}`);
  const incidentUrl = `${WEB_ORIGIN}/incidents/${ctx.incident.id}`;
  await updateIncidentMainMessage(
    ctx.incident.id,
    `:x: ${ctx.incident.title} — Investigation failed`,
    incidentBlocks({
      emoji: "x",
      status: `Investigation failed · ${reason}`,
      title: ctx.incident.title,
      tagline: summary,
      projectName: ctx.project.name,
      service: ctx.incident.service,
      buttons: [{ text: "Open in Superlog", url: incidentUrl, actionId: "open_superlog" }],
      incidentId: ctx.incident.id,
      showResolveButton: true,
    }),
  );
}

export async function moveAgentRunToAwaitingHuman(
  ctx: AgentRunContext,
  question: string,
  summary: string,
): Promise<void> {
  await agentRunLifecycle.pauseForHuman({
    id: ctx.agentRun.id,
    currentState: ctx.agentRun.state,
    summary,
    question,
  });
  await postIncidentThreadMessage(ctx.incident.id, `:speech_balloon: ${summary}\n${question}`);
  const incidentUrl = `${WEB_ORIGIN}/incidents/${ctx.incident.id}`;
  await updateIncidentMainMessage(
    ctx.incident.id,
    `:speech_balloon: ${ctx.incident.title} — Awaiting human input`,
    incidentBlocks({
      emoji: "speech_balloon",
      status: "Awaiting human input",
      title: ctx.incident.title,
      tagline: question,
      projectName: ctx.project.name,
      service: ctx.incident.service,
      buttons: [{ text: "Open in Superlog", url: incidentUrl, actionId: "open_superlog" }],
      incidentId: ctx.incident.id,
      showResolveButton: true,
    }),
  );
}

export async function moveAgentRunToBlockedNoGithub(
  ctx: AgentRunContext,
  reason: "no_github_install" | "no_accessible_repos",
  summary: string,
): Promise<void> {
  await agentRunLifecycle.blockForGithub({
    id: ctx.agentRun.id,
    currentState: ctx.agentRun.state,
    summary,
    reason,
  });
  const incidentUrl = `${WEB_ORIGIN}/incidents/${ctx.incident.id}`;
  const installUrl = `${WEB_ORIGIN}/settings?tab=github`;
  const tagline = "Connect a GitHub repo so we can investigate.";
  await postIncidentThreadMessage(
    ctx.incident.id,
    `:no_entry: ${summary}\nConnect GitHub: ${installUrl}`,
  );
  await updateIncidentMainMessage(
    ctx.incident.id,
    `:no_entry: ${ctx.incident.title} — Investigation blocked`,
    incidentBlocks({
      emoji: "no_entry",
      status: "Investigation blocked — connect GitHub",
      title: ctx.incident.title,
      tagline,
      projectName: ctx.project.name,
      service: ctx.incident.service,
      buttons: [
        { text: "Connect GitHub", url: installUrl, actionId: "connect_github" },
        { text: "Open in Superlog", url: incidentUrl, actionId: "open_superlog" },
      ],
      incidentId: ctx.incident.id,
      showResolveButton: true,
    }),
  );
}
