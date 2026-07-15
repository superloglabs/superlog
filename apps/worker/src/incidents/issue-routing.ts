// When a new error signature joins an incident, decide whether to start a fresh
// investigation or steer the one that already ran.
//
// Background: a single root cause is a "fingerprint factory" — one bug surfaces
// as many distinct issues (per vendor, per log layer). Issue-grouping correctly
// folds them into one incident, but every new signature joining an incident
// re-armed the investigation trigger, so a still-firing incident was
// investigated again and again, opening a duplicate PR each time. Once an
// incident has already been investigated, a new signature should continue that
// investigation (it can confirm the existing fix already covers it, or extend
// it) instead of starting over.

export type IssueArrivalAction = "investigate" | "steer";

export type IssueArrivalRoutingInput = {
  // A brand-new incident was opened for this issue (including recurrence
  // incidents chained to a predecessor) — there is nothing to steer.
  createdIncident: boolean;
  // The incident's auto-investigation is on a `fixed_in_current_code` cooldown.
  // Route to the normal investigate path, which no-ops under suppression — we
  // must not bypass that guard by steering.
  suppressed: boolean;
  // The incident's most recent run finished (complete/failed). Only then is
  // there a durable investigation to continue. No run, an active run, or a
  // dormant (blocked) run all take the existing investigate path.
  latestRunIsTerminal: boolean;
};

export function decideIssueArrivalRouting(input: IssueArrivalRoutingInput): IssueArrivalAction {
  if (input.createdIncident) return "investigate";
  if (!input.latestRunIsTerminal) return "investigate";
  if (input.suppressed) return "investigate";
  return "steer";
}

// The application service checks this only after acquiring the Incident row
// lock. Resolution and investigation queueing therefore have one serialized
// decision point: whichever transaction wins determines whether work starts.
export function canQueueInvestigationForLockedIncident(status: string | null): boolean {
  return status === "open";
}
