export const QUIET_INCIDENT_PERIOD_MS = 14 * 24 * 60 * 60 * 1000;

export type QuietIncidentCandidate = {
  incidentId: string;
  linkedIssues: Array<{ id: string; lastSeen: Date }>;
};

export type QuietIncidentResolutionDecision =
  | { kind: "keep_open"; reason: "no_linked_issues" | "recent_recurrence" }
  | { kind: "resolve"; quietSince: Date; linkedIssueCount: number };

export function decideQuietIncidentResolution(
  candidate: QuietIncidentCandidate,
  now: Date,
): QuietIncidentResolutionDecision {
  if (candidate.linkedIssues.length === 0) {
    return { kind: "keep_open", reason: "no_linked_issues" };
  }

  const quietSince = new Date(
    Math.max(...candidate.linkedIssues.map((issue) => issue.lastSeen.getTime())),
  );
  if (now.getTime() - quietSince.getTime() < QUIET_INCIDENT_PERIOD_MS) {
    return { kind: "keep_open", reason: "recent_recurrence" };
  }

  return {
    kind: "resolve",
    quietSince,
    linkedIssueCount: candidate.linkedIssues.length,
  };
}
