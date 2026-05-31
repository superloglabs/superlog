// Cooldown for auto-agentRun after the agent resolves an incident as
// `fixed_in_current_code`. Production typically lags repo by minutes-to-hours,
// so the same exception will recur and regress the incident; without a
// cooldown, every recurrence fires another agent round that arrives at the
// same verdict. We saw this in the wild for incident 9a23b1fe (interview
// dashboard SSE / Postgres pool exhaustion): 9 agentRuns in 4 hours,
// every one of them concluding "fix is on staging, awaiting promotion."
//
// The cooldown applies only to auto-agentRun triggered by issue
// transitions (`queueAgentRunIfNeeded`). Manual restarts via the API
// bypass it — if a human is hitting "investigate again," they want it.
// Other resolution reasons (transient_condition_cleared, upstream_recovered)
// don't get a cooldown: a recurrence under those is real new signal worth
// re-investigating.

export const FIXED_IN_CURRENT_CODE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export function isAutoAgentRunSuppressed(
  incident: { autoInvestigateSuppressedUntil: Date | null },
  now: Date,
): boolean {
  return (
    !!incident.autoInvestigateSuppressedUntil &&
    incident.autoInvestigateSuppressedUntil.getTime() > now.getTime()
  );
}
