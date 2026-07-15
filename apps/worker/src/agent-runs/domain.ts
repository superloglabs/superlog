export type AgentRunState =
  | "queued"
  | "repo_discovery"
  | "running"
  | "awaiting_human"
  | "awaiting_events"
  | "resuming"
  | "pr_retry_queued"
  | "blocked_no_github"
  | "complete"
  | "failed";

// States the worker actively ticks. `blocked_no_github` is intentionally
// excluded: those rows sit dormant until a GitHub install webhook or manual
// restart requeues them. `pr_retry_queued` is a failed run that a human asked
// to re-deliver: the tick re-runs PR delivery from the patch already on record
// (no re-investigation). `resuming` is a previously-terminal run that a human
// message reactivated: the tick resumes its durable provider session in place
// (no re-investigation) — the heart of "talking to an investigation".
// `awaiting_events` is a run whose turn ended with PRs out for review: the
// session stays durable and PR events (comment/merge/close) resume it.
export const ACTIVE_STATES: readonly AgentRunState[] = [
  "queued",
  "repo_discovery",
  "running",
  "awaiting_human",
  "awaiting_events",
  "resuming",
  "pr_retry_queued",
] as const;

export const TERMINAL_STATES: readonly AgentRunState[] = ["complete", "failed"] as const;

export const DORMANT_STATES: readonly AgentRunState[] = ["blocked_no_github"] as const;

export function isActiveState(state: AgentRunState | string): boolean {
  return (ACTIVE_STATES as readonly string[]).includes(state);
}

export type LifecycleEventKind =
  | "agent_run_queued"
  | "agent_run_started"
  | "awaiting_human"
  | "awaiting_events"
  | "blocked_no_github"
  | "unblocked"
  | "resumed"
  | "terminal_failure"
  | "agent_run_pr_retry_queued"
  | "pr_opened"
  | "merged_into_incident"
  | "agent_run_completed"
  | "repo_selected"
  | "incident_context_changed"
  | "internal_agent_session_termination_pending";

export class IllegalAgentRunTransitionError extends Error {
  constructor(method: string, from: string, allowedFrom: readonly AgentRunState[]) {
    super(
      `${method}: cannot transition from "${from}"; allowed source states: ${allowedFrom.join(", ")}`,
    );
    this.name = "IllegalTransitionError";
  }
}

export function assertAgentRunSourceState(
  method: string,
  current: AgentRunState | string,
  allowed: readonly AgentRunState[],
): void {
  if (!(allowed as readonly string[]).includes(current)) {
    throw new IllegalAgentRunTransitionError(method, current, allowed);
  }
}
