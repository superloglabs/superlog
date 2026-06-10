// Follow-up agent runs: a human interaction (PR comment, feedback, Slack
// reply) after a prior investigation finished revives the agent as a NEW
// agent_runs row on the same incident. Completed provider sessions cannot be
// resumed, so revival always means a fresh run that carries the prior run's
// result, handoff notes, and the triggering interaction in its prompt.
//
// Shared between the API (webhooks/interactivity enqueue) and the worker
// (context assembly), hence it lives in the db package next to the other
// cross-app domain logic.
import { and, desc, eq } from "drizzle-orm";
import type { DB } from "./client.js";
import * as schema from "./schema.js";
import type {
  AgentRunFollowUpInteraction,
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
  "pr_retry_queued",
  "blocked_no_github",
];

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
  if (input.followUpCount >= MAX_FOLLOW_UP_RUNS) {
    return { action: "skip", reason: "follow_up_cap_reached" };
  }
  if (input.activeRun) {
    // A queued follow-up absorbs further interactions (a PR review burst is
    // one run, not one per comment). Anything past queued is already talking
    // to a session — don't stack a second run behind it.
    if (input.activeRun.state === "queued" && input.activeRun.trigger !== "incident") {
      return { action: "append", runId: input.activeRun.id };
    }
    return { action: "skip", reason: "run_active" };
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
    trigger: Exclude<AgentRunTrigger, "incident">;
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
  const followUpCount = runs.filter((run) => run.trigger !== "incident").length;

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
    await db
      .update(schema.agentRuns)
      .set({ triggerDetail: detail, updatedAt: now })
      .where(and(eq(schema.agentRuns.id, verdict.runId), eq(schema.agentRuns.state, "queued")));
    return { outcome: "appended", agentRunId: verdict.runId };
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

function followUpQueuedSummary(trigger: Exclude<AgentRunTrigger, "incident">): string {
  switch (trigger) {
    case "pr_comment":
      return "Follow-up investigation queued from a pull request comment.";
    case "feedback":
      return "Follow-up investigation queued from user feedback.";
    case "slack_reply":
      return "Follow-up investigation queued from a Slack reply.";
  }
}
