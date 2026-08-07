// Grouping is the decision boundary. A standalone Issue opens an Incident and
// starts agent work; an Issue grouped into an existing Incident is done once it
// is linked, even when that historical Incident had to be reopened.

export type IssueArrivalAction = "investigate" | "none";

export type IssueArrivalRoutingInput = {
  shouldInvestigate: boolean;
};

export function decideIssueArrivalRouting(input: IssueArrivalRoutingInput): IssueArrivalAction {
  return input.shouldInvestigate ? "investigate" : "none";
}

export function shouldAppendIssueToActiveInvestigation(input: {
  linkedIssue: boolean;
  hasActiveRun: boolean;
}): boolean {
  return input.linkedIssue && input.hasActiveRun;
}

// The application service checks this only after acquiring the Incident row
// lock. Resolution and investigation queueing therefore have one serialized
// decision point: whichever transaction wins determines whether work starts.
export function canQueueInvestigationForLockedIncident(status: string | null): boolean {
  return status === "open";
}
