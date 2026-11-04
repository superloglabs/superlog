// How often the incident detail view re-fetches while an investigation is live.
//
// The worker flushes new transcript events to Postgres every few seconds while a
// run is active, so a short poll makes the page feel live without any realtime
// transport. Polling is gated on the run's state: we only refetch while the run
// is in an active state and stop entirely once it's terminal or dormant, so an
// idle incident page costs nothing.
export const INCIDENT_POLL_INTERVAL_MS = 3000;

// Mirror of the worker's ACTIVE_STATES (apps/worker/src/agent-runs/domain.ts).
// These are the states where the worker is still ticking the run, so new events
// can still land. `awaiting_human` is included on purpose: a reply arriving on
// another channel (e.g. Slack) flips it back to `resuming`, and we want the page
// to catch that without a manual refresh. `awaiting_events` is the same case for
// pull requests: a review comment or merge resumes the run, so a page parked
// there has to keep polling to see it. Terminal (`complete`/`failed`) and
// dormant (`blocked_no_github`) states are omitted: they won't produce more
// events until an external event requeues them, so we let the poll stop.
const ACTIVE_AGENT_RUN_STATES: Readonly<Record<string, true>> = {
  queued: true,
  repo_discovery: true,
  running: true,
  awaiting_human: true,
  awaiting_events: true,
  resuming: true,
  pr_retry_queued: true,
};

// Returns the poll interval for react-query's `refetchInterval`, or `false` to
// stop polling. Fails closed: an unknown or missing state does not poll.
export function incidentPollIntervalMs(agentRunState: string | null | undefined): number | false {
  if (agentRunState && Object.hasOwn(ACTIVE_AGENT_RUN_STATES, agentRunState)) {
    return INCIDENT_POLL_INTERVAL_MS;
  }
  return false;
}
