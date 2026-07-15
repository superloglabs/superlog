import { publishAwaitingEventsUpdateIfCurrent } from "./status.js";

export type IncidentResolutionFollowUpOutcome = "skipped" | "published" | "reconciled";

// Completion snapshots arrive after the terminal tool dispatch has already
// committed the resolution. Re-check that exact resolution epoch before each
// dependent phase: PR reconciliation can take time, and a manual reopen that
// wins between phases must suppress resolved provider copy. The publication
// guard checks once more after its non-transactional provider calls and
// repairs their final state if the epoch changed in flight.
export async function reconcileIncidentResolutionFollowUp(opts: {
  isCurrentResolution(): Promise<boolean>;
  closePullRequests(): Promise<unknown>;
  publish(): Promise<void>;
  reconcileStalePublication(): Promise<void>;
}): Promise<IncidentResolutionFollowUpOutcome> {
  if (!(await opts.isCurrentResolution())) return "skipped";
  await opts.closePullRequests();
  return publishAwaitingEventsUpdateIfCurrent({
    isCurrent: opts.isCurrentResolution,
    publish: opts.publish,
    reconcileStalePublication: opts.reconcileStalePublication,
  });
}
