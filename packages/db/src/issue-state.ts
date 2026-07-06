import type * as schema from "./schema.js";

// Issue lifecycle state machine. Issues carry the durable verdict about an
// error signature (silence it, watch it, it's fixed); incidents are the
// per-episode work item. Ingest consults `decideOccurrenceAction` on every
// fresh occurrence of a known fingerprint, so these transitions are the whole
// contract between the noise model and the pipeline.

export const ISSUE_STATUSES: readonly schema.IssueStatus[] = [
  "open",
  "silenced",
  "under_observation",
  "resolved",
] as const;

// Trailing window used to evaluate `rate` escalation triggers: the trigger
// fires when the issue averaged >= perMinute events over this window.
export const OBSERVATION_RATE_WINDOW_MINUTES = 5;

export type IssueOccurrenceAction =
  // `open` issues follow the normal path: bump counters, touch the incident,
  // let grouping decide where a brand-new signature lands.
  | { kind: "investigate" }
  // `silenced` and `under_observation` occurrences accumulate on the row
  // (event_count/last_seen still move — reporting and trigger evaluation
  // depend on it) but never touch incidents.
  | { kind: "suppress"; status: "silenced" | "under_observation" }
  // `resolved` issues that recur re-open and start a NEW incident chained to
  // the predecessor via incidents.previous_incident_id.
  | { kind: "recur" };

export function decideOccurrenceAction(status: schema.IssueStatus | string): IssueOccurrenceAction {
  switch (status) {
    case "silenced":
      return { kind: "suppress", status: "silenced" };
    case "under_observation":
      return { kind: "suppress", status: "under_observation" };
    case "resolved":
      return { kind: "recur" };
    default:
      return { kind: "investigate" };
  }
}

export function buildIssueSilencePatch(now: Date = new Date()): Partial<schema.Issue> {
  return {
    status: "silenced",
    silencedAt: now,
    escalationTrigger: null,
    observationStartedAt: null,
    observationBaselineEventCount: null,
  };
}

export function buildIssueObservePatch(opts: {
  trigger: schema.IssueEscalationTrigger;
  baselineEventCount: number;
  now?: Date;
}): Partial<schema.Issue> {
  return {
    status: "under_observation",
    silencedAt: null,
    escalationTrigger: opts.trigger,
    observationStartedAt: opts.now ?? new Date(),
    observationBaselineEventCount: opts.baselineEventCount,
  };
}

export function buildIssueResolvePatch(): Partial<schema.Issue> {
  return {
    status: "resolved",
    silencedAt: null,
    escalationTrigger: null,
    observationStartedAt: null,
    observationBaselineEventCount: null,
  };
}

// Recurrence and escalation both land here: back to `open`, observation and
// silence bookkeeping cleared so the next verdict starts from a blank slate.
export function buildIssueReopenPatch(): Partial<schema.Issue> {
  return {
    status: "open",
    silencedAt: null,
    escalationTrigger: null,
    observationStartedAt: null,
    observationBaselineEventCount: null,
  };
}

// Escalation triggers arrive from the agent result (LLM output) and from API
// payloads; both are untrusted. Returns null rather than throwing so callers
// can decide their own fallback (the completion path downgrades a malformed
// observe verdict to a plain silence).
export function parseEscalationTrigger(raw: unknown): schema.IssueEscalationTrigger | null {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as { kind?: unknown; perMinute?: unknown; count?: unknown };
  if (candidate.kind === "rate") {
    const perMinute = Number(candidate.perMinute);
    if (!Number.isFinite(perMinute) || perMinute <= 0) return null;
    return { kind: "rate", perMinute };
  }
  if (candidate.kind === "count") {
    const count = Number(candidate.count);
    if (!Number.isInteger(count) || count <= 0) return null;
    return { kind: "count", count };
  }
  return null;
}

export type EscalationEvaluationInput = {
  trigger: schema.IssueEscalationTrigger;
  // issues.event_count at evaluation time.
  currentEventCount: number;
  // issues.observation_baseline_event_count captured when observation began.
  baselineEventCount: number;
  // Events attributed to this issue over the trailing rate window (ClickHouse
  // count over OBSERVATION_RATE_WINDOW_MINUTES). Only consulted for `rate`.
  eventsInRateWindow: number;
};

export function escalationTriggerFired(input: EscalationEvaluationInput): boolean {
  if (input.trigger.kind === "count") {
    return input.currentEventCount - input.baselineEventCount >= input.trigger.count;
  }
  return input.eventsInRateWindow >= input.trigger.perMinute * OBSERVATION_RATE_WINDOW_MINUTES;
}
