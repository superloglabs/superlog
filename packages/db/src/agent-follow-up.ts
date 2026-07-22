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
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DB } from "./client.js";
import * as schema from "./schema.js";
import { isFollowUpTrigger } from "./schema.js";
import type {
  AgentRunFollowUpInteraction,
  AgentRunFollowUpTrigger,
  AgentRunTrigger,
  AgentRunTriggerDetail,
} from "./schema.js";

type AgentFollowUpTransaction = Parameters<Parameters<DB["transaction"]>[0]>[0];

type LockedAgentFollowUpAggregate = {
  incident: {
    id: string;
    projectId: string;
    status: schema.IncidentStatus;
  };
  runs: Array<{
    id: string;
    state: schema.AgentRun["state"];
    trigger: AgentRunTrigger;
    triggerDetail: AgentRunTriggerDetail | null;
    prompt: string | null;
    providerSessionId: string | null;
    completedAt: Date | null;
    runtime: string;
  }>;
};

async function lockAgentFollowUpAggregate(
  tx: AgentFollowUpTransaction,
  incidentId: string,
): Promise<LockedAgentFollowUpAggregate | null> {
  const incidents = await tx
    .select({
      id: schema.incidents.id,
      projectId: schema.incidents.projectId,
      status: schema.incidents.status,
    })
    .from(schema.incidents)
    .where(eq(schema.incidents.id, incidentId))
    .orderBy(schema.incidents.id)
    .for("update");
  const incident = incidents[0];
  if (!incident) return null;

  const runs = await tx
    .select({
      id: schema.agentRuns.id,
      state: schema.agentRuns.state,
      trigger: schema.agentRuns.trigger,
      triggerDetail: schema.agentRuns.triggerDetail,
      prompt: schema.agentRuns.prompt,
      providerSessionId: schema.agentRuns.providerSessionId,
      completedAt: schema.agentRuns.completedAt,
      runtime: schema.agentRuns.runtime,
    })
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.incidentId, incidentId))
    .orderBy(desc(schema.agentRuns.createdAt), desc(schema.agentRuns.id))
    .for("update");
  return { incident, runs };
}

export const MAX_FOLLOW_UP_RUNS = 3;
export const FOLLOW_UP_MAX_AGE_DAYS = 14;

const TERMINAL_PRIOR_STATES = new Set(["complete", "failed"]);
const EXECUTING_STATES = [
  "repo_discovery",
  "running",
  "awaiting_human",
  "awaiting_events",
  "resuming",
  "pr_retry_queued",
  "blocked_no_github",
];

const STARTED_FOLLOW_UP_STATES = new Set([
  "repo_discovery",
  "running",
  "awaiting_human",
  "awaiting_events",
  "resuming",
  "pr_retry_queued",
]);

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
  | {
      outcome: "skipped";
      reason: Extract<FollowUpVerdict, { action: "skip" }>["reason"] | "incident_not_open";
    };

type RequestFollowUpArgs = {
  incidentId: string;
  trigger: AgentRunFollowUpTrigger;
  interaction: AgentRunFollowUpInteraction;
  confirmed?: boolean;
  now?: Date;
};

export const OPEN_PR_REQUEST_TEXT =
  "Fix the confirmed incident cause and open a pull request with the validated changes.";

export type RequestOpenPrAgentRunResult = RequestFollowUpResult | { outcome: "duplicate" };

export async function requestOpenPrAgentRun(
  db: DB,
  args: {
    incidentId: string;
    requestedBy: string | null;
    requestId: string;
    now?: Date;
  },
): Promise<RequestOpenPrAgentRunResult> {
  const now = args.now ?? new Date();
  return db.transaction(async (tx) => {
    const aggregate = await lockAgentFollowUpAggregate(tx, args.incidentId);
    if (!aggregate) return { outcome: "skipped", reason: "no_prior_run" };

    // Slack retries a block action with the same action timestamp when the
    // acknowledgement misses its deadline. Claim that stable request id in
    // the same transaction as enqueueing so a retry cannot append duplicate
    // instructions or produce a second acknowledgement message.
    const [claimed] = await tx
      .insert(schema.incidentEvents)
      .values({
        incidentId: args.incidentId,
        kind: "open_pr_requested",
        summary: "Pull request implementation requested from Slack.",
        detail: { requestedBy: args.requestedBy },
        dedupeKey: `open_pr_request:${args.requestId}`,
        processedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: schema.incidentEvents.id });
    if (!claimed) return { outcome: "duplicate" };

    return requestFollowUpAgentRunInTx(
      tx,
      {
        incidentId: args.incidentId,
        trigger: "slack_open_pr",
        confirmed: true,
        interaction: {
          channel: "slack_open_pr",
          author: args.requestedBy,
          text: OPEN_PR_REQUEST_TEXT,
          occurredAt: now.toISOString(),
        },
        now,
      },
      aggregate,
    );
  });
}

const RESTARTABLE_AGENT_RUN_STATES = [
  "queued",
  "repo_discovery",
  "running",
  "awaiting_human",
  "awaiting_events",
  "resuming",
  "pr_retry_queued",
  "blocked_no_github",
];

export type RestartAgentRunResult =
  | { outcome: "restarted"; agentRun: schema.AgentRun }
  | { outcome: "incident_not_open" }
  | { outcome: "no_prior_run" }
  | { outcome: "latest_run_changed" };

export type RetryBlockedAgentRunResult =
  | { outcome: "retried"; agentRun: schema.AgentRun }
  | { outcome: "not_blocked" }
  | { outcome: "agent_runs_disabled" }
  | { outcome: "incident_not_open" }
  | { outcome: "no_prior_run" };

export async function restartAgentRun(
  db: DB,
  args: {
    incidentId: string;
    runtime: string;
    expectedLatestRunId?: string;
    now?: Date;
  },
): Promise<RestartAgentRunResult> {
  const now = args.now ?? new Date();
  return db.transaction(async (tx) => {
    const aggregate = await lockAgentFollowUpAggregate(tx, args.incidentId);
    if (!aggregate || aggregate.runs.length === 0) return { outcome: "no_prior_run" };
    if (aggregate.incident.status !== "open") return { outcome: "incident_not_open" };
    const latest = aggregate.runs[0];
    if (!latest) return { outcome: "no_prior_run" };
    if (args.expectedLatestRunId && latest.id !== args.expectedLatestRunId) {
      return { outcome: "latest_run_changed" };
    }

    const created = await createRestartedAgentRun(tx, aggregate, {
      incidentId: args.incidentId,
      runtime: args.runtime,
      now,
    });
    return { outcome: "restarted", agentRun: created };
  });
}

export async function retryBlockedAgentRun(
  db: DB,
  args: { incidentId: string; now?: Date },
): Promise<RetryBlockedAgentRunResult> {
  const now = args.now ?? new Date();
  return db.transaction(async (tx) => {
    const aggregate = await lockAgentFollowUpAggregate(tx, args.incidentId);
    if (!aggregate || aggregate.runs.length === 0) return { outcome: "no_prior_run" };
    if (aggregate.incident.status !== "open") return { outcome: "incident_not_open" };
    const latest = aggregate.runs[0];
    if (!latest) return { outcome: "no_prior_run" };
    if (latest.state !== "blocked_no_github") return { outcome: "not_blocked" };
    const automation = await tx.query.projectAutomationSettings.findFirst({
      where: eq(schema.projectAutomationSettings.projectId, aggregate.incident.projectId),
      columns: { agentRunEnabled: true },
    });
    if (automation?.agentRunEnabled === false) return { outcome: "agent_runs_disabled" };

    const created = await createRestartedAgentRun(tx, aggregate, {
      incidentId: args.incidentId,
      runtime: latest.runtime,
      now,
      preserveTriggerContext: true,
    });
    return { outcome: "retried", agentRun: created };
  });
}

async function createRestartedAgentRun(
  tx: AgentFollowUpTransaction,
  aggregate: LockedAgentFollowUpAggregate,
  args: {
    incidentId: string;
    runtime: string;
    now: Date;
    preserveTriggerContext?: boolean;
  },
): Promise<schema.AgentRun> {
  const latest = aggregate.runs[0];
  if (!latest) throw new Error("cannot restart an incident without an agent run");
  const now = args.now;

  const superseded = await tx
    .update(schema.agentRuns)
    .set({ state: "superseded", completedAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.agentRuns.incidentId, args.incidentId),
        inArray(schema.agentRuns.state, RESTARTABLE_AGENT_RUN_STATES),
      ),
    )
    .returning({
      id: schema.agentRuns.id,
      providerSessionId: schema.agentRuns.providerSessionId,
      providerSessionStatus: schema.agentRuns.providerSessionStatus,
    });
  const sessionsToTerminate = superseded.filter(
    (run) => run.providerSessionId && run.providerSessionStatus !== "terminated",
  );
  if (sessionsToTerminate.length > 0) {
    await tx
      .update(schema.agentRuns)
      .set({ providerSessionStatus: "termination_pending", updatedAt: now })
      .where(
        inArray(
          schema.agentRuns.id,
          sessionsToTerminate.map((run) => run.id),
        ),
      );
  }
  if (superseded.length > 0) {
    await tx.insert(schema.incidentEvents).values(
      superseded.map((run) => ({
        incidentId: args.incidentId,
        agentRunId: run.id,
        kind: "agent_run_superseded",
        summary: "Investigation superseded by a restart.",
        dedupeKey: `superseded:${run.id}:${now.getTime()}`,
        processedAt: now,
      })),
    );
  }

  const [created] = await tx
    .insert(schema.agentRuns)
    .values({
      incidentId: args.incidentId,
      runtime: args.runtime,
      state: "queued",
      ...(args.preserveTriggerContext
        ? {
            trigger: latest.trigger,
            triggerDetail: latest.triggerDetail,
            prompt: latest.prompt,
          }
        : {}),
    })
    .returning();
  if (!created) throw new Error("failed to restart agent run");
  if (superseded.length > 0) {
    // A lifecycle delivery is deduped across the whole Incident. Keep its
    // unprocessed input attached to the run that can still consume it;
    // otherwise a webhook redelivery would correctly dedupe against an
    // event stranded on a superseded predecessor and no run would act.
    await tx
      .update(schema.incidentEvents)
      .set({ agentRunId: created.id })
      .where(
        and(
          inArray(
            schema.incidentEvents.agentRunId,
            superseded.map((run) => run.id),
          ),
          inArray(schema.incidentEvents.kind, [...INBOUND_INTERACTION_EVENT_KINDS]),
          isNull(schema.incidentEvents.processedAt),
        ),
      );
  }
  await tx.insert(schema.incidentEvents).values({
    incidentId: args.incidentId,
    agentRunId: created.id,
    kind: "agent_run_restarted",
    summary: "Investigation restarted.",
    detail: {
      restartedFromAgentRunId: latest.id,
      restartedFromState: latest.state,
    },
    dedupeKey: `restart:${created.id}`,
    processedAt: now,
  });
  return created;
}

async function listOpenPullRequestContext(
  db: AgentFollowUpTransaction,
  incidentId: string,
): Promise<schema.AgentRunFollowUpPullRequest[]> {
  const rows = await db.query.agentPullRequests.findMany({
    where: and(
      eq(schema.agentPullRequests.incidentId, incidentId),
      eq(schema.agentPullRequests.state, "open"),
    ),
    orderBy: [asc(schema.agentPullRequests.createdAt), asc(schema.agentPullRequests.id)],
    columns: {
      id: true,
      repoFullName: true,
      prNumber: true,
      url: true,
      branchName: true,
      baseBranch: true,
      state: true,
    },
  });
  return rows.map((pullRequest) => ({
    agentPrId: pullRequest.id,
    repoFullName: pullRequest.repoFullName,
    prNumber: pullRequest.prNumber,
    url: pullRequest.url,
    branchName: pullRequest.branchName,
    baseBranch: pullRequest.baseBranch,
    state: pullRequest.state,
  }));
}

// Evaluate and act: insert a queued follow-up run (with a follow_up_queued
// timeline event), append the interaction to an already-queued follow-up, or
// skip. The Incident and all of its AgentRuns form the serialization boundary:
// two public callers cannot both enqueue from the same terminal predecessor or
// overwrite one another while appending to a queued successor.
export async function requestFollowUpAgentRun(
  db: DB,
  args: RequestFollowUpArgs,
): Promise<RequestFollowUpResult> {
  return db.transaction(async (tx) => {
    const aggregate = await lockAgentFollowUpAggregate(tx, args.incidentId);
    if (!aggregate) return { outcome: "skipped", reason: "no_prior_run" };
    return requestFollowUpAgentRunInTx(tx, args, aggregate);
  });
}

async function requestFollowUpAgentRunInTx(
  db: AgentFollowUpTransaction,
  args: RequestFollowUpArgs,
  aggregate: LockedAgentFollowUpAggregate,
): Promise<RequestFollowUpResult> {
  const now = args.now ?? new Date();
  const { incident, runs } = aggregate;
  if (incident.status !== "open") {
    return { outcome: "skipped", reason: "incident_not_open" };
  }

  const automation = await db.query.projectAutomationSettings.findFirst({
    where: eq(schema.projectAutomationSettings.projectId, incident.projectId),
    columns: { agentRunEnabled: true, autoFollowUpEnabled: true, agentRunProvider: true },
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
  const pullRequests = await listOpenPullRequestContext(db, args.incidentId);

  if (verdict.action === "append") {
    const existing = activeRun?.triggerDetail ?? { interactions: [] };
    const detail: AgentRunTriggerDetail = {
      ...existing,
      interactions: [...existing.interactions, args.interaction],
      pullRequests,
    };
    // The state predicate guards against the run leaving `queued` between
    // our read and this write; .returning() tells us whether we actually
    // landed the interaction. On a miss the run is already executing — same
    // outcome as the run_active skip, and the caller should not believe the
    // interaction was persisted.
    const [appended] = await db
      .update(schema.agentRuns)
      .set({
        triggerDetail: detail,
        // A human explicitly asking for implementation must upgrade a queued
        // findings-only follow-up so the worker grants its one-shot PR tools.
        ...(args.trigger === "slack_open_pr" ? { trigger: args.trigger } : {}),
        updatedAt: now,
      })
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
      triggerDetail: { interactions: [args.interaction], pullRequests },
    })
    .returning({ id: schema.agentRuns.id });
  if (!created) throw new Error("failed to enqueue follow-up agent run");

  await db.insert(schema.incidentEvents).values({
    agentRunId: created.id,
    incidentId: args.incidentId,
    kind: "follow_up_queued",
    summary: followUpQueuedSummary(args.trigger),
    detail: { trigger: args.trigger, interaction: args.interaction, pullRequests },
    dedupeKey: `follow_up:${created.id}`,
    processedAt: now,
  });

  return { outcome: "enqueued", agentRunId: created.id };
}

export type RecordInboundInteractionResult =
  | { outcome: "accepted"; action: "resume" | "steer" | "cold_start"; agentRunId?: string }
  | { outcome: "duplicate" }
  | { outcome: "skipped"; reason: string };

export const INBOUND_INTERACTION_EVENT_KINDS = ["human_reply", "github_comment"] as const;
export type InboundInteractionEventKind = (typeof INBOUND_INTERACTION_EVENT_KINDS)[number];

export function isInboundInteractionEventKind(kind: string): kind is InboundInteractionEventKind {
  return (INBOUND_INTERACTION_EVENT_KINDS as readonly string[]).includes(kind);
}

function inboundInteractionEventKind(
  interaction: AgentRunFollowUpInteraction,
): InboundInteractionEventKind {
  return interaction.channel === "pr_comment" ? "github_comment" : "human_reply";
}

// The shared inbound path for every channel (Slack reply, PR comment/review,
// feedback): decide whether to continue the durable session or cold-start, then
// act. For resume/steer it records a source-specific inbound event (carrying
// the channel `origin` so the worker can route the reply back) and reactivates
// a terminal run into `resuming`; for cold_start it delegates to
// requestFollowUpAgentRun.
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
    // PR merge/close lifecycle delivery may continue an existing durable
    // session (including a queued handoff successor), but must not create a
    // brand-new investigation. Evaluated only after the Incident lock and
    // fresh run read so the deterministic fallback cannot race a handoff.
    existingSessionOnly?: boolean;
    now?: Date;
  },
): Promise<RecordInboundInteractionResult> {
  const now = args.now ?? new Date();
  const eventKind = inboundInteractionEventKind(args.interaction);
  return db.transaction(async (tx) => {
    // Shared lock order with resolution and dead-session handoff: Incident
    // first, then its AgentRuns. Any reply that wins before handoff is copied
    // by that handoff; any reply that wins after sees the queued successor.
    const aggregate = await lockAgentFollowUpAggregate(tx, args.incidentId);
    if (!aggregate) return { outcome: "skipped", reason: "no_prior_run" };
    const { incident } = aggregate;
    if (incident.status !== "open") {
      return { outcome: "skipped", reason: "incident_not_open" };
    }
    const latestRun = aggregate.runs[0] ?? null;

    // Incident-scoped idempotency survives a handoff that changes the target
    // AgentRun; the row-level partial unique index alone only dedupes within
    // one run.
    const seen = await tx.query.incidentEvents.findFirst({
      where: and(
        eq(schema.incidentEvents.incidentId, args.incidentId),
        eq(schema.incidentEvents.dedupeKey, args.dedupeKey),
      ),
      columns: { id: true },
    });
    if (seen) return { outcome: "duplicate" };

    const automation = await tx.query.projectAutomationSettings.findFirst({
      where: eq(schema.projectAutomationSettings.projectId, incident.projectId),
      columns: { agentRunEnabled: true, autoFollowUpEnabled: true },
    });
    const verdict = decideInboundContinuation({
      agentRunEnabled: automation?.agentRunEnabled ?? true,
      autoFollowUpEnabled: automation?.autoFollowUpEnabled ?? true,
      confirmed: args.confirmed ?? false,
      latestRun,
    });
    if (verdict.action === "skip") return { outcome: "skipped", reason: verdict.reason };

    if (verdict.action === "cold_start") {
      const canAppendLockedSuccessor =
        latestRun?.state === "queued" && isFollowUpTrigger(latestRun.trigger);
      const canLeavePendingForStartedRun =
        latestRun !== null &&
        isFollowUpTrigger(latestRun.trigger) &&
        STARTED_FOLLOW_UP_STATES.has(latestRun.state);
      if (args.existingSessionOnly && canLeavePendingForStartedRun) {
        // The queued successor may have started between handoff and this
        // transaction. Its row is locked now, so attach the lifecycle message
        // as pending context instead of treating the durable target as absent
        // and falling through to deterministic resolution.
        const [recorded] = await tx
          .insert(schema.incidentEvents)
          .values({
            agentRunId: latestRun.id,
            incidentId: args.incidentId,
            kind: eventKind,
            summary: args.interaction.text,
            detail: { ...(args.detail ?? {}), origin: args.interaction },
            dedupeKey: args.dedupeKey,
          })
          .onConflictDoNothing({
            target: [schema.incidentEvents.agentRunId, schema.incidentEvents.dedupeKey],
            where: sql`${schema.incidentEvents.agentRunId} is not null`,
          })
          .returning({ id: schema.incidentEvents.id });
        if (!recorded) return { outcome: "duplicate" };
        return { outcome: "accepted", action: "steer" };
      }
      if (args.existingSessionOnly && !canAppendLockedSuccessor) {
        return { outcome: "skipped", reason: "no_resumable_session" };
      }

      // Claim the dedupe key before enqueue/append. It is processed because
      // the interaction itself is carried in triggerDetail, not consumed as a
      // pending steer. Release it when the follow-up action is skipped or
      // throws so a transient failure remains retryable.
      let claimId: string | null = null;
      if (latestRun) {
        const [claim] = await tx
          .insert(schema.incidentEvents)
          .values({
            agentRunId: latestRun.id,
            incidentId: args.incidentId,
            kind: eventKind,
            summary: args.interaction.text,
            detail: { ...(args.detail ?? {}), origin: args.interaction },
            dedupeKey: args.dedupeKey,
            processedAt: now,
          })
          .onConflictDoNothing({
            target: [schema.incidentEvents.agentRunId, schema.incidentEvents.dedupeKey],
            where: sql`${schema.incidentEvents.agentRunId} is not null`,
          })
          .returning({ id: schema.incidentEvents.id });
        if (!claim) return { outcome: "duplicate" };
        claimId = claim.id;
      }

      const releaseClaim = async () => {
        if (claimId) {
          await tx.delete(schema.incidentEvents).where(eq(schema.incidentEvents.id, claimId));
        }
      };
      let result: RequestFollowUpResult;
      try {
        result = await requestFollowUpAgentRunInTx(
          tx,
          {
            incidentId: args.incidentId,
            trigger: args.interaction.channel,
            interaction: args.interaction,
            confirmed: args.confirmed,
            now,
          },
          aggregate,
        );
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

    // resume | steer: the locked run cannot become the failed predecessor
    // while this event is inserted.
    const [recorded] = await tx
      .insert(schema.incidentEvents)
      .values({
        agentRunId: verdict.runId,
        incidentId: args.incidentId,
        kind: eventKind,
        summary: args.interaction.text,
        detail: { ...(args.detail ?? {}), origin: args.interaction },
        dedupeKey: args.dedupeKey,
      })
      .onConflictDoNothing({
        target: [schema.incidentEvents.agentRunId, schema.incidentEvents.dedupeKey],
        where: sql`${schema.incidentEvents.agentRunId} is not null`,
      })
      .returning({ id: schema.incidentEvents.id });
    if (!recorded) return { outcome: "duplicate" };

    if (verdict.action === "resume") {
      await tx
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
  });
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
    case "slack_open_pr":
      return "Pull request implementation queued from Slack.";
    case "linear_reply":
      return "Follow-up investigation queued from a Linear prompt.";
    case "web_chat":
      return "Follow-up investigation queued from an incident chat message.";
    case "issue_joined":
      return "Follow-up investigation queued: a new error signature joined this incident.";
  }
}
