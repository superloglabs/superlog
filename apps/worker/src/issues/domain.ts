import type { IssueSample, schema } from "@superlog/db";
import type { GroupingCandidateIncident, GroupingNewIssue } from "../grouping.js";

export type IssueGroupingState = "grouped" | "pending" | "standalone" | "failed";
export type IssueGroupingSource = "heuristic" | "llm" | "manual" | null;

export type LinkedIncidentIssue = {
  incidentId: string;
  title: string;
  exceptionType: string;
  message: string | null;
  topFrame: string | null;
  normalizedFrames: string[];
  lastSample: IssueSample | null;
  lastSeen: Date;
};

export type IncidentMatch = {
  incident: schema.Incident;
  source: Exclude<IssueGroupingSource, "manual" | null>;
  reason: string | null;
};

export function overlapCount(a: string[], b: string[]): number {
  const bset = new Set(b.slice(0, 5));
  return a.slice(0, 5).filter((frame) => bset.has(frame)).length;
}

export function issueSample(issue: schema.Issue): IssueSample | null {
  return (issue.lastSample ?? null) as IssueSample | null;
}

export function groupingIssueInput(issue: schema.Issue): GroupingNewIssue {
  const sample = issueSample(issue);
  return {
    id: issue.id,
    title: issue.title,
    service: issue.service,
    exceptionType: issue.exceptionType,
    message: issue.message,
    topFrame: issue.topFrame,
    normalizedFrames: issue.normalizedFrames ?? [],
    observedAt: issue.lastSeen.toISOString(),
    stacktrace: sample?.stacktrace ?? null,
    traceId: sample?.traceId ?? null,
    spanId: sample?.spanId ?? null,
  };
}

export function findHeuristicIncidentMatch(
  issue: schema.Issue,
  candidates: schema.Incident[],
  linked: LinkedIncidentIssue[],
): IncidentMatch | null {
  if ((issue.normalizedFrames ?? []).length < 2) return null;

  let best: { incident: schema.Incident; overlap: number; reason: string } | null = null;
  for (const candidate of candidates) {
    const overlaps = linked
      .filter((row) => row.incidentId === candidate.id)
      .map((row) => overlapCount(issue.normalizedFrames ?? [], row.normalizedFrames ?? []));
    const overlap = overlaps.length > 0 ? Math.max(...overlaps) : 0;
    if (overlap < 2) continue;
    if (!best || overlap > best.overlap) {
      best = {
        incident: candidate,
        overlap,
        reason: `Matched existing incident by ${overlap} overlapping stack frames.`,
      };
    }
  }
  if (!best) return null;
  return { incident: best.incident, source: "heuristic", reason: best.reason };
}

// Same trace id ⇒ same request ⇒ same incident. A span exception and its own
// log line, or several log lines from one failed request, are one error
// observed more than once — join them deterministically instead of leaving it
// to the LLM (whose "distinct exception type" heuristic wrongly splits a log,
// whose type is a severity like ERROR, from its span). Trace ids are
// per-request, so this never merges unrelated failures. Returns the most
// recently-seen candidate that shares the issue's trace id.
export function findSameTraceIncidentMatch(
  issue: schema.Issue,
  candidates: schema.Incident[],
  linked: LinkedIncidentIssue[],
): IncidentMatch | null {
  const traceId = issueSample(issue)?.traceId;
  if (!traceId) return null;

  let best: { incident: schema.Incident; lastSeen: number } | null = null;
  for (const candidate of candidates) {
    const shares = linked.some(
      (row) => row.incidentId === candidate.id && row.lastSample?.traceId === traceId,
    );
    if (!shares) continue;
    const lastSeen = candidate.lastSeen.getTime();
    if (!best || lastSeen > best.lastSeen) best = { incident: candidate, lastSeen };
  }
  if (!best) return null;
  return {
    incident: best.incident,
    source: "heuristic",
    reason: `Same request: shares trace id ${traceId} with this incident.`,
  };
}

export function buildGroupingCandidate(
  incident: schema.Incident,
  linked: LinkedIncidentIssue[],
): GroupingCandidateIncident | null {
  const representative = linked
    .filter((row) => row.incidentId === incident.id)
    .sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime())[0];
  if (!representative) return null;
  return {
    id: incident.id,
    title: incident.title,
    service: incident.service,
    firstSeen: incident.firstSeen.toISOString(),
    lastSeen: incident.lastSeen.toISOString(),
    issueCount: incident.issueCount,
    representative: {
      exceptionType: representative.exceptionType,
      message: representative.message,
      topFrame: representative.topFrame,
      normalizedFrames: representative.normalizedFrames ?? [],
      traceId: representative.lastSample?.traceId ?? null,
      spanId: representative.lastSample?.spanId ?? null,
    },
  };
}
