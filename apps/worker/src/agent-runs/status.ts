import {
  type AgentRunResult,
  db,
  enqueueAgentRunAwaitingInput,
  enqueueAgentRunFailed,
  schema,
} from "@superlog/db";
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
  // Total seconds the run has spent parked in `awaiting_human`. This time is
  // excluded from the budget: a run waiting on a human reply isn't stuck, and
  // a human can legitimately take hours to answer. Without this a run that
  // parked on `ask_human` gets reaped the moment it resumes, discarding a
  // finished investigation (prod incident 2026-07-09).
  awaitingHumanSeconds?: number;
}): boolean {
  if (!opts.startedAt) return false;
  const parkedMs = Math.max(0, opts.awaitingHumanSeconds ?? 0) * 1_000;
  const ageMs = opts.now.getTime() - opts.startedAt.getTime() - parkedMs;
  const budgetMs = WALL_CLOCK_MULTIPLIER * opts.maxRuntimeMinutes * 60_000;
  return ageMs > budgetMs;
}

// Total wall-clock seconds a run has spent parked in `awaiting_human`, derived
// from its lifecycle events. `pauseForHuman` emits an `awaiting_human` event;
// the matching `resumeRunning` emits `resumed`. Pair each `awaiting_human` with
// the next `resumed` and sum the gaps. A trailing `awaiting_human` with no
// matching `resumed` means the run is still parked, so it counts up to `now`.
// Nested/duplicate `awaiting_human` events (a re-park before a resume) collapse
// to the earliest park start, which is the conservative choice — it can only
// exclude more idle time, never fabricate active time.
export function awaitingHumanSecondsFromEvents(
  events: ReadonlyArray<{ kind: string; createdAt: Date }>,
  now: Date,
): number {
  const relevant = events
    .filter((e) => e.kind === "awaiting_human" || e.kind === "resumed")
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  let totalMs = 0;
  let parkedSince: Date | null = null;
  for (const event of relevant) {
    if (event.kind === "awaiting_human") {
      if (parkedSince === null) parkedSince = event.createdAt;
    } else if (parkedSince !== null) {
      totalMs += event.createdAt.getTime() - parkedSince.getTime();
      parkedSince = null;
    }
  }
  if (parkedSince !== null) totalMs += now.getTime() - parkedSince.getTime();
  return Math.max(0, Math.round(totalMs / 1_000));
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

// Failure log message with the reason inlined as plain words. The reason must
// be in the message body (not only in structured attrs) because log issues
// fingerprint on the normalized body — a constant "agent run failed" string
// collapses every failure mode into one issue forever, so a brand-new failure
// mode never produces a new issue/incident/investigation. Spaces instead of
// underscores keep messageBucketFor from collapsing long enum tokens to <id>.
export function agentRunFailureLogMessage(reason: schema.AgentRunFailureReason): string {
  return `agent run failed: ${reason.replaceAll("_", " ")}`;
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
    agentRunFailureLogMessage(reason),
  );
  await agentRunLifecycle.fail({
    id: ctx.agentRun.id,
    currentState: ctx.agentRun.state,
    reason,
    summary,
    category,
    existingResult: detail?.existingResult ?? null,
  });
  await enqueueAgentRunFailed(ctx.agentRun.id).catch((err) =>
    logger.error(
      {
        scope: "webhooks.enqueue",
        agent_run_id: ctx.agentRun.id,
        err: err instanceof Error ? err.message : String(err),
      },
      "failed to enqueue incident.updated webhook (agent_failed)",
    ),
  );
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
      titleUrl: incidentUrl,
      tagline: summary,
      projectName: ctx.project.name,
      service: ctx.incident.service,
      buttons: [],
      incidentId: ctx.incident.id,
      showResolveButton: true,
      // No thumbs: the run errored out, so there are no investigation findings
      // to rate. A 👎 here would conflate "unhelpful findings" with "the run
      // crashed" and muddy the helpful/unhelpful signal.
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
  await enqueueAgentRunAwaitingInput(ctx.agentRun.id, {
    reason: "repository_selection",
    summary,
    question,
  }).catch((err) =>
    logger.error(
      {
        scope: "webhooks.enqueue",
        agent_run_id: ctx.agentRun.id,
        err: err instanceof Error ? err.message : String(err),
      },
      "failed to enqueue incident.updated webhook (agent_awaiting_input)",
    ),
  );
  await postIncidentThreadMessage(ctx.incident.id, `:speech_balloon: ${summary}\n${question}`);
  const incidentUrl = `${WEB_ORIGIN}/incidents/${ctx.incident.id}`;
  await updateIncidentMainMessage(
    ctx.incident.id,
    `:speech_balloon: ${ctx.incident.title} — Awaiting human input`,
    incidentBlocks({
      emoji: "speech_balloon",
      status: "Awaiting human input",
      title: ctx.incident.title,
      titleUrl: incidentUrl,
      tagline: question,
      projectName: ctx.project.name,
      service: ctx.incident.service,
      buttons: [],
      incidentId: ctx.incident.id,
      showResolveButton: true,
      showFeedbackButtons: true,
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
  await enqueueAgentRunAwaitingInput(ctx.agentRun.id, {
    reason,
    summary,
    question: null,
  }).catch((err) =>
    logger.error(
      {
        scope: "webhooks.enqueue",
        agent_run_id: ctx.agentRun.id,
        err: err instanceof Error ? err.message : String(err),
      },
      "failed to enqueue incident.updated webhook (agent_awaiting_input)",
    ),
  );
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
      titleUrl: incidentUrl,
      tagline,
      projectName: ctx.project.name,
      service: ctx.incident.service,
      buttons: [{ text: "Connect GitHub", url: installUrl, actionId: "connect_github" }],
      incidentId: ctx.incident.id,
      showResolveButton: true,
      // No thumbs: the investigation is blocked before it can start (no GitHub
      // repo connected), so there's nothing to rate yet.
    }),
  );
}
