// Talking to an investigation: a human interaction (PR comment, feedback,
// Slack or Linear reply) after a run finished should continue the SAME durable provider
// session — resume it in place, keep the repo mounted, keep committing to the
// same PR — rather than spinning up a fresh investigation. `decideInboundContinuation`
// is the routing seam: resume the live session, steer it if it's mid-turn, or
// fall back to a cold-start run (`requestFollowUpAgentRun`) only when no
// resumable session exists (never created, or reclaimed by the provider).
//
// The cold-start path below carries the prior run's result, handoff notes, and
// the triggering interaction in its prompt — it is the fallback, not the
// default.
//
// Shared between the API (webhooks/interactivity) and the worker (context
// assembly), hence it lives in the db package next to the other cross-app
// domain logic.
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { DB } from "./client.js";
import * as schema from "./schema.js";
import { isFollowUpTrigger } from "./schema.js";
import type {
  AgentRunFollowUpInteraction,
  AgentRunFollowUpTrigger,
  AgentRunTrigger,
  AgentRunTriggerDetail,
} from "./schema.js";

export const MAX_FOLLOW_UP_RUNS = 3;
export const FOLLOW_UP_MAX_AGE_DAYS = 14;

const TERMINAL_PRIOR_STATES = new Set(["complete", "failed"]);
const EXECUTING_STATES = [
  "repo_discovery",
  "running",
  "awaiting_human",
  "awaiting_events",
  "pr_retry_queued",
  "blocked_no_github",
];

// States where the agent is actively working a turn — a new message should be
// steered into the live session, not stacked behind it.
const EXECUTING_LIVE_STATES = new Set(["running", "repo_discovery"]);

export type InboundContinuationInput = {
  agentRunEnabled: boolean;
  autoFollowUpEnabled: boolean;
  // An explicit human confirmation (e.g. the feedback button) bypasses the
  // auto-follow-up project gate. Continuity has no per-incident cap — talking
  // to the investigation is the point — so confirmed only matters for the gate.
  confirmed: boolean;
  // The most recent run on the incident (any state), or null if none exists.
  latestRun: { id: string; state: string; providerSessionId: string | null } | null;
};

export type InboundContinuationVerdict =
  | { action: "resume"; runId: string }
  | { action: "steer"; runId: string }
  | { action: "cold_start" }
  | {
      action: "skip";
      reason: "agent_runs_disabled" | "auto_follow_up_disabled" | "no_prior_run";
    };

// Route an inbound human message: continue the existing session where possible,
// fall back to a cold-start run otherwise. Pure — the worker performs the
// actual resume/steer and converts cold_start into `requestFollowUpAgentRun`.
export function decideInboundContinuation(
  input: InboundContinuationInput,
): InboundContinuationVerdict {
  if (!input.agentRunEnabled) return { action: "skip", reason: "agent_runs_disabled" };
  if (!input.autoFollowUpEnabled && !input.confirmed) {
    return { action: "skip", reason: "auto_follow_up_disabled" };
  }
  const run = input.latestRun;
  if (!run) return { action: "skip", reason: "no_prior_run" };

  // The agent explicitly paused for input (awaiting_human) or parked while its
  // PRs are out for review (awaiting_events) — always deliver. The worker
  // resumes the session, or requeues the run if it paused before a session
  // existed.
  if (run.state === "awaiting_human" || run.state === "awaiting_events") {
    return { action: "resume", runId: run.id };
  }

  if (EXECUTING_LIVE_STATES.has(run.state)) {
    // Mid-turn: inject into the live session so the agent adapts in real time.
    // With no session yet (repo discovery still running) there's nothing to
    // steer — defer to the cold-start path, which itself no-ops while a run is
    // active, so we never stack a duplicate.
    return run.providerSessionId ? { action: "steer", runId: run.id } : { action: "cold_start" };
  }

  // Terminal (or otherwise dormant): resume the durable session in place. Only
  // when the session is gone do we cold-start a fresh contextful run.
  return run.providerSessionId ? { action: "resume", runId: run.id } : { action: "cold_start" };
}

export type FollowUpEligibilityInput = {
  agentRunEnabled: boolean;
  autoFollowUpEnabled: boolean;
  // True for explicitly human-confirmed requests (e.g. the feedback
  // notification button). Bypasses the auto-follow-up project gate only;
  // caps and staleness still apply.
  confirmed: boolean;
  priorRun: { state: string; completedAt: Date | null } | null;
  followUpCount: number;
  activeRun: { id: string; state: string; trigger: AgentRunTrigger } | null;
  now: Date;
};

export type FollowUpVerdict =
  | { action: "enqueue" }
  | { action: "append"; runId: string }
  | {
      action: "skip";
      reason:
        | "agent_runs_disabled"
        | "auto_follow_up_disabled"
        | "no_prior_run"
        | "prior_run_too_old"
        | "follow_up_cap_reached"
        | "run_active";
    };

export function evaluateFollowUpEligibility(input: FollowUpEligibilityInput): FollowUpVerdict {
  if (!input.agentRunEnabled) return { action: "skip", reason: "agent_runs_disabled" };
  if (!input.autoFollowUpEnabled && !input.confirmed) {
    return { action: "skip", reason: "auto_follow_up_disabled" };
  }
  if (input.activeRun) {
    // A queued follow-up absorbs further interactions (a PR review burst is
    // one run, not one per comment). Checked before the cap on purpose:
    // appending doesn't create a run, so a burst that crosses the cap mid-
    // review still lands in the queued run instead of being dropped.
    // Anything past queued is already talking to a session — don't stack a
    // second run behind it.
    if (input.activeRun.state === "queued" && isFollowUpTrigger(input.activeRun.trigger)) {
      return { action: "append", runId: input.activeRun.id };
    }
    return { action: "skip", reason: "run_active" };
  }
  if (input.followUpCount >= MAX_FOLLOW_UP_RUNS) {
    return { action: "skip", reason: "follow_up_cap_reached" };
  }
  if (!input.priorRun || !TERMINAL_PRIOR_STATES.has(input.priorRun.state)) {
    return { action: "skip", reason: "no_prior_run" };
  }
  const completedAt = input.priorRun.completedAt;
  const maxAgeMs = FOLLOW_UP_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  if (!completedAt || input.now.getTime() - completedAt.getTime() > maxAgeMs) {
    return { action: "skip", reason: "prior_run_too_old" };
  }
  return { action: "enqueue" };
}

export type RequestFollowUpResult =
  | { outcome: "enqueued"; agentRunId: string }
  | { outcome: "appended"; agentRunId: string }
  | { outcome: "skipped"; reason: Extract<FollowUpVerdict, { action: "skip" }>["reason"] };

// Evaluate and act: insert a queued follow-up run (with a follow_up_queued
// timeline event), append the interaction to an already-queued follow-up, or
// skip. Callers pass the interaction from their channel verbatim.
export async function requestFollowUpAgentRun(
  db: DB,
  args: {
    incidentId: string;
    trigger: AgentRunFollowUpTrigger;
    interaction: AgentRunFollowUpInteraction;
    confirmed?: boolean;
    now?: Date;
  },
): Promise<RequestFollowUpResult> {
  const now = args.now ?? new Date();

  const incident = await db.query.incidents.findFirst({
    where: eq(schema.incidents.id, args.incidentId),
    columns: { id: true, projectId: true },
  });
  if (!incident) return { outcome: "skipped", reason: "no_prior_run" };

  const automation = await db.query.projectAutomationSettings.findFirst({
    where: eq(schema.projectAutomationSettings.projectId, incident.projectId),
    columns: { agentRunEnabled: true, autoFollowUpEnabled: true, agentRunProvider: true },
  });

  const runs = await db.query.agentRuns.findMany({
    where: eq(schema.agentRuns.incidentId, args.incidentId),
    orderBy: [desc(schema.agentRuns.createdAt)],
    columns: {
      id: true,
      state: true,
      trigger: true,
      triggerDetail: true,
      completedAt: true,
      runtime: true,
    },
  });
  const activeRun =
    runs.find((run) => run.state === "queued" || EXECUTING_STATES.includes(run.state)) ?? null;
  const priorRun = runs.find((run) => TERMINAL_PRIOR_STATES.has(run.state)) ?? null;
  const followUpCount = runs.filter((run) => isFollowUpTrigger(run.trigger)).length;

  const verdict = evaluateFollowUpEligibility({
    agentRunEnabled: automation?.agentRunEnabled ?? true,
    autoFollowUpEnabled: automation?.autoFollowUpEnabled ?? true,
    confirmed: args.confirmed ?? false,
    priorRun: priorRun ? { state: priorRun.state, completedAt: priorRun.completedAt } : null,
    followUpCount,
    activeRun: activeRun
      ? { id: activeRun.id, state: activeRun.state, trigger: activeRun.trigger }
      : null,
    now,
  });

  if (verdict.action === "skip") return { outcome: "skipped", reason: verdict.reason };

  if (verdict.action === "append") {
    const existing = activeRun?.triggerDetail ?? { interactions: [] };
    const detail: AgentRunTriggerDetail = {
      interactions: [...existing.interactions, args.interaction],
    };
    // The state predicate guards against the run leaving `queued` between
    // our read and this write; .returning() tells us whether we actually
    // landed the interaction. On a miss the run is already executing — same
    // outcome as the run_active skip, and the caller should not believe the
    // interaction was persisted.
    const [appended] = await db
      .update(schema.agentRuns)
      .set({ triggerDetail: detail, updatedAt: now })
      .where(and(eq(schema.agentRuns.id, verdict.runId), eq(schema.agentRuns.state, "queued")))
      .returning({ id: schema.agentRuns.id });
    if (!appended) return { outcome: "skipped", reason: "run_active" };
    return { outcome: "appended", agentRunId: appended.id };
  }

  const runtime = priorRun?.runtime ?? automation?.agentRunProvider;
  const [created] = await db
    .insert(schema.agentRuns)
    .values({
      incidentId: args.incidentId,
      ...(runtime ? { runtime } : {}),
      state: "queued",
      trigger: args.trigger,
      triggerDetail: { interactions: [args.interaction] },
    })
    .returning({ id: schema.agentRuns.id });
  if (!created) throw new Error("failed to enqueue follow-up agent run");

  await db.insert(schema.incidentEvents).values({
    agentRunId: created.id,
    incidentId: args.incidentId,
    kind: "follow_up_queued",
    summary: followUpQueuedSummary(args.trigger),
    detail: { trigger: args.trigger, interaction: args.interaction },
    dedupeKey: `follow_up:${created.id}`,
    processedAt: now,
  });

  return { outcome: "enqueued", agentRunId: created.id };
}

export type RecordInboundInteractionResult =
  | { outcome: "accepted"; action: "resume" | "steer" | "cold_start"; agentRunId?: string }
  | { outcome: "duplicate" }
  | { outcome: "skipped"; reason: string };

// The shared inbound path for every channel (Slack reply, PR comment/review,
// feedback): decide whether to continue the durable session or cold-start, then
// act. For resume/steer it records a `human_reply` event (carrying the channel
// `origin` so the worker can route the reply back) and reactivates a terminal
// run into `resuming`; for cold_start it delegates to requestFollowUpAgentRun.
// `dedupeKey` makes provider/webhook retries idempotent — a swallowed insert
// returns `duplicate` so the caller neither reactivates twice nor double-acks.
export async function recordInboundInteraction(
  db: DB,
  args: {
    incidentId: string;
    interaction: AgentRunFollowUpInteraction;
    dedupeKey: string;
    // Channel-specific event detail (Slack ids, etc.); `origin` is merged in.
    detail?: Record<string, unknown>;
    confirmed?: boolean;
    now?: Date;
  },
): Promise<RecordInboundInteractionResult> {
  const now = args.now ?? new Date();
  const incident = await db.query.incidents.findFirst({
    where: eq(schema.incidents.id, args.incidentId),
    columns: { id: true, projectId: true },
  });
  if (!incident) return { outcome: "skipped", reason: "no_prior_run" };

  const automation = await db.query.projectAutomationSettings.findFirst({
    where: eq(schema.projectAutomationSettings.projectId, incident.projectId),
    columns: { agentRunEnabled: true, autoFollowUpEnabled: true },
  });

  const latestRun = await db.query.agentRuns.findFirst({
    where: eq(schema.agentRuns.incidentId, args.incidentId),
    orderBy: [desc(schema.agentRuns.createdAt)],
    columns: { id: true, state: true, providerSessionId: true },
  });

  const verdict = decideInboundContinuation({
    agentRunEnabled: automation?.agentRunEnabled ?? true,
    autoFollowUpEnabled: automation?.autoFollowUpEnabled ?? true,
    confirmed: args.confirmed ?? false,
    latestRun: latestRun ?? null,
  });

  if (verdict.action === "skip") return { outcome: "skipped", reason: verdict.reason };

  if (verdict.action === "cold_start") {
    // Idempotency for provider/webhook retries: cold-start enqueues/appends a
    // run, which the dedupe key doesn't otherwise guard. Two layers, both
    // BEFORE we enqueue so a retry can never double-process one message:
    //   1. Incident-scoped read — catches a sequential retry whose latest run
    //      changed (the prior attempt's marker now sits on a different run).
    //   2. Atomic claim insert against the current latest run — the unique
    //      (agentRunId, dedupeKey) index lets only one of N concurrent racers
    //      win; the losers get an empty `.returning()` and bail. cold_start
    //      only arises when a latest run exists, so there is always a run to
    //      claim against. The marker is pre-processed so it's never re-consumed
    //      as a pending human reply.
    const seen = await db.query.incidentEvents.findFirst({
      where: and(
        eq(schema.incidentEvents.incidentId, args.incidentId),
        eq(schema.incidentEvents.dedupeKey, args.dedupeKey),
      ),
      columns: { id: true },
    });
    if (seen) return { outcome: "duplicate" };

    // Claim the dedupe key atomically (the unique (agentRunId, dedupeKey) index
    // lets only one concurrent racer win). We RELEASE the claim if the enqueue
    // then fails or is skipped, so the key is only durably consumed once the
    // follow-up actually exists — a transient failure or a later state change
    // can be retried instead of silently dropped.
    let claimId: string | null = null;
    if (latestRun) {
      const [claim] = await db
        .insert(schema.incidentEvents)
        .values({
          agentRunId: latestRun.id,
          incidentId: args.incidentId,
          kind: "human_reply",
          summary: args.interaction.text,
          detail: { ...(args.detail ?? {}), origin: args.interaction },
          dedupeKey: args.dedupeKey,
          processedAt: now,
        })
        .onConflictDoNothing({
          // Matches the PARTIAL unique index incident_events_dedupe_idx
          // (WHERE agent_run_id IS NOT NULL) — Postgres only binds ON CONFLICT
          // to a partial index when the predicate is repeated here.
          target: [schema.incidentEvents.agentRunId, schema.incidentEvents.dedupeKey],
          where: sql`${schema.incidentEvents.agentRunId} is not null`,
        })
        .returning({ id: schema.incidentEvents.id });
      if (!claim) return { outcome: "duplicate" };
      claimId = claim.id;
    }

    const releaseClaim = async () => {
      if (claimId) {
        await db.delete(schema.incidentEvents).where(eq(schema.incidentEvents.id, claimId));
      }
    };

    let result: RequestFollowUpResult;
    try {
      result = await requestFollowUpAgentRun(db, {
        incidentId: args.incidentId,
        trigger: args.interaction.channel,
        interaction: args.interaction,
        confirmed: args.confirmed,
        now,
      });
    } catch (err) {
      await releaseClaim();
      throw err;
    }
    if (result.outcome === "skipped") {
      await releaseClaim();
      return { outcome: "skipped", reason: result.reason };
    }
    return { outcome: "accepted", action: "cold_start", agentRunId: result.agentRunId };
  }

  // resume | steer: record the message against the run, carrying its origin.
  const [recorded] = await db
    .insert(schema.incidentEvents)
    .values({
      agentRunId: verdict.runId,
      incidentId: args.incidentId,
      kind: "human_reply",
      summary: args.interaction.text,
      detail: { ...(args.detail ?? {}), origin: args.interaction },
      dedupeKey: args.dedupeKey,
    })
    .onConflictDoNothing({
      // Matches the PARTIAL unique index incident_events_dedupe_idx
      // (WHERE agent_run_id IS NOT NULL); the predicate must be repeated for
      // Postgres to bind ON CONFLICT to a partial index.
      target: [schema.incidentEvents.agentRunId, schema.incidentEvents.dedupeKey],
      where: sql`${schema.incidentEvents.agentRunId} is not null`,
    })
    .returning({ id: schema.incidentEvents.id });
  if (!recorded) return { outcome: "duplicate" };

  if (verdict.action === "resume") {
    // Reactivate a terminal run so the tick resumes its session in place. The
    // state-guarded WHERE is a no-op for awaiting_human (already active) and
    // TOCTOU-safe if the run moved since we read it.
    await db
      .update(schema.agentRuns)
      .set({ state: "resuming", completedAt: null, failureReason: null, updatedAt: now })
      .where(
        and(
          eq(schema.agentRuns.id, verdict.runId),
          inArray(schema.agentRuns.state, ["complete", "failed"]),
        ),
      );
  }

  return { outcome: "accepted", action: verdict.action };
}

function followUpQueuedSummary(trigger: AgentRunFollowUpTrigger): string {
  switch (trigger) {
    case "pr_comment":
      return "Follow-up investigation queued from a pull request comment.";
    case "pr_merged":
      return "Follow-up investigation queued: an agent pull request was merged.";
    case "pr_closed":
      return "Follow-up investigation queued: an agent pull request was closed.";
    case "feedback":
      return "Follow-up investigation queued from user feedback.";
    case "slack_reply":
      return "Follow-up investigation queued from a Slack reply.";
    case "linear_reply":
      return "Follow-up investigation queued from a Linear prompt.";
    case "web_chat":
      return "Follow-up investigation queued from an incident chat message.";
    case "issue_joined":
      return "Follow-up investigation queued: a new error signature joined this incident.";
  }
}
