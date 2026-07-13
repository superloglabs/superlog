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
// A session that has never reported any provider-active time (active_seconds
// is null/0 on every collect pass) is likely permanently stuck. Apply a tighter
// multiplier so these sessions fail faster — giving users quicker feedback and
// preventing large synchronous cleanup bursts when many zero-activity sessions
// age out at the same time (prod incident 2026-07-13).
export const ZERO_ACTIVITY_WALL_CLOCK_MULTIPLIER = 1;

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
  // Cumulative provider-active minutes as stored on the run (updated each tick
  // from snapshot.activeSeconds). When 0 the session has never had any provider
  // activity; use the tighter ZERO_ACTIVITY_WALL_CLOCK_MULTIPLIER so it is
  // reaped in one budget cycle rather than four. Omit (or pass undefined) to
  // keep the normal WALL_CLOCK_MULTIPLIER — callers without access to the
  // cumulative count stay on the existing behaviour.
  cumulativeRuntimeMinutes?: number;
}): boolean {
  if (!opts.startedAt) return false;
  const parkedMs = Math.max(0, opts.awaitingHumanSeconds ?? 0) * 1_000;
  const ageMs = opts.now.getTime() - opts.startedAt.getTime() - parkedMs;
  const hasActivity = opts.cumulativeRuntimeMinutes === undefined || opts.cumulativeRuntimeMinutes > 0;
  const multiplier = hasActivity ? WALL_CLOCK_MULTIPLIER : ZERO_ACTIVITY_WALL_CLOCK_MULTIPLIER;
  const budgetMs = multiplier * opts.maxRuntimeMinutes * 60_000;
  return ageMs > budgetMs;
}

// Wall-clock seconds a run spent parked in `awaiting_human` *within its
// wall-clock measurement window* `[startedAt, now]`, derived from lifecycle
// events. A managed-session pause (`pauseForHuman` from `running`) emits an
// `awaiting_human` event and the matching `resumeRunning` emits `resumed`; we
// pair each such open→close and sum the gaps, clamped to the window.
//
// Two things are deliberately excluded, both because the exclusion must never
// exceed the age it's subtracted from (`now - startedAt`), or the wall-clock
// backstop silently disables itself:
//   - Parks before `startedAt` — a `repo_discovery` pause happens before the
//     managed session (and `startedAt`) exists, so its time was never part of
//     the age. Clamping to the window drops it.
//   - A dangling `awaiting_human` with no matching `resumed`. The pre-session
//     resume path (`requeueAfterHumanReply`) requeues *without* a `resumed`
//     event, so an unclosed park is that repo-discovery pause — already over,
//     its end untracked — not an active wait. Only closed intervals count.
// Nested/duplicate `awaiting_human` events collapse to the earliest park start.
export function awaitingHumanSecondsFromEvents(opts: {
  events: ReadonlyArray<{ kind: string; createdAt: Date }>;
  startedAt: Date | null;
  now: Date;
}): number {
  if (!opts.startedAt) return 0;
  const windowStart = opts.startedAt.getTime();
  const windowEnd = opts.now.getTime();
  const relevant = opts.events
    .filter((e) => e.kind === "awaiting_human" || e.kind === "resumed")
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  let totalMs = 0;
  let parkedSince: Date | null = null;
  for (const event of relevant) {
    if (event.kind === "awaiting_human") {
      if (parkedSince === null) parkedSince = event.createdAt;
    } else if (parkedSince !== null) {
      const from = Math.max(parkedSince.getTime(), windowStart);
      const to = Math.min(event.createdAt.getTime(), windowEnd);
      if (to > from) totalMs += to - from;
      parkedSince = null;
    }
  }
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

// Park a run whose turn ended without a terminal call while its PRs are out
// for review. The session stays durable; a PR comment/merge/close (or any
// inbound human message) resumes it via the same continuation path as
// awaiting_human. Returns false when a concurrent pass already moved the run
// (the transition is conditional) — the caller must skip its side effects.
export async function moveAgentRunToAwaitingEvents(
  ctx: AgentRunContext,
  result: AgentRunResult,
  openPrUrls: string[],
): Promise<boolean> {
  const parked = await agentRunLifecycle.pauseForEvents({
    id: ctx.agentRun.id,
    currentState: ctx.agentRun.state,
    result,
  });
  if (!parked) {
    logger.info(
      { scope: "agent_run", agent_run_id: ctx.agentRun.id, incident_id: ctx.incident.id },
      "skipping awaiting_events park; a concurrent pass already transitioned the run",
    );
    return false;
  }
  const prList = openPrUrls.length > 0 ? ` Open PRs: ${openPrUrls.join(", ")}` : "";
  await postIncidentThreadMessage(
    ctx.incident.id,
    `:hourglass_flowing_sand: Investigation is waiting on PR review.${prList}`,
  );
  const incidentUrl = `${WEB_ORIGIN}/incidents/${ctx.incident.id}`;
  await updateIncidentMainMessage(
    ctx.incident.id,
    `:hourglass_flowing_sand: ${ctx.incident.title} — Waiting on PR review`,
    incidentBlocks({
      emoji: "hourglass_flowing_sand",
      status: "Waiting on PR review",
      title: ctx.incident.title,
      tagline: result.summary || "The investigation opened PRs and is waiting for review or merge.",
      projectName: ctx.project.name,
      service: ctx.incident.service,
      buttons: [
        { text: "Open in Superlog", url: incidentUrl, actionId: "open_superlog" },
        ...(openPrUrls[0] ? [{ text: "View PR", url: openPrUrls[0], actionId: "view_pr" }] : []),
      ],
      incidentId: ctx.incident.id,
      showResolveButton: true,
      // The one-click merge action targets "the incident's latest open PR",
      // so with several PRs out it would merge only one and resolve the whole
      // incident — only offer it when the target is unambiguous.
      showMergePrButton: openPrUrls.length === 1,
    }),
  );
  return true;
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
