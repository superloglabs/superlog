// Pure tool implementations: searches and projections over a fixed array
// of GroupingCandidateIncident. Used by the agent's tool dispatcher and
// directly callable from tests.
import {
  GROUPING_DETAIL_MESSAGE_MAX_CHARS,
  GROUPING_SEARCH_MESSAGE_MAX_CHARS,
  type GroupingCandidateIncident,
  candidateIssues,
  candidateMatchesFilters,
  compactDiagnosticText,
  endpointHostsFromText,
  endpointKind,
  environmentForResourceAttrs,
  parseListFilters,
  parseSearchInput,
  uniqueSorted,
} from "./domain.js";

export function candidateSearchText(candidate: GroupingCandidateIncident): string {
  const representative = candidate.representative;
  return [
    candidate.id,
    candidate.title,
    candidate.service,
    candidate.firstSeen,
    candidate.lastSeen,
    String(candidate.issueCount),
    representative?.exceptionType,
    representative?.message,
    representative?.topFrame,
    representative?.normalizedFrames.join(" "),
    representative?.traceId,
    representative?.spanId,
    representative?.resourceAttrs ? JSON.stringify(representative.resourceAttrs) : null,
    candidate.issues ? JSON.stringify(candidate.issues) : null,
    candidate.investigation ? JSON.stringify(candidate.investigation) : null,
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n")
    .toLowerCase();
}

export function candidatePreview(candidate: GroupingCandidateIncident) {
  const representative = candidate.representative;
  const issues = candidateIssues(candidate);
  const services = uniqueSorted([candidate.service, ...issues.map((issue) => issue.service)]);
  const environments = uniqueSorted([
    environmentForResourceAttrs(representative?.resourceAttrs),
    ...issues.map((issue) => environmentForResourceAttrs(issue.resourceAttrs)),
  ]);
  return {
    id: candidate.id,
    title: candidate.title,
    service: candidate.service,
    services,
    environments,
    firstSeen: candidate.firstSeen,
    lastSeen: candidate.lastSeen,
    issueCount: candidate.issueCount,
    environment: environmentForResourceAttrs(representative?.resourceAttrs),
    linkedIssueCount: issues.length,
    latestInvestigation: candidate.investigation
      ? {
          state: candidate.investigation.state,
          completedAt: candidate.investigation.completedAt,
          selectedRepoFullName: candidate.investigation.selectedRepoFullName,
        }
      : null,
    representative: representative
      ? {
          exceptionType: representative.exceptionType,
          message: compactDiagnosticText(representative.message, GROUPING_SEARCH_MESSAGE_MAX_CHARS),
          topFrame: representative.topFrame,
          traceId: representative.traceId,
          spanId: representative.spanId,
          resourceAttrs: representative.resourceAttrs ?? null,
        }
      : null,
  };
}

export function listIncidentTitles(
  candidates: GroupingCandidateIncident[],
  input: unknown,
): unknown {
  const filters = parseListFilters(input);
  const rows = candidates
    .filter((candidate) => candidateMatchesFilters(candidate, filters))
    .slice(0, filters.limit)
    .map((candidate) => {
      const preview = candidatePreview(candidate);
      return {
        id: preview.id,
        title: preview.title,
        service: preview.service,
        services: preview.services,
        environments: preview.environments,
        issueCount: preview.issueCount,
        linkedIssueCount: preview.linkedIssueCount,
        lastSeen: preview.lastSeen,
        latestInvestigation: preview.latestInvestigation,
      };
    });
  return {
    service: filters.service,
    environment: filters.environment,
    returned: rows.length,
    totalCandidates: candidates.length,
    results: rows,
  };
}

function incrementCount(map: Map<string, number>, key: string | null | undefined): void {
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + 1);
}

function mapToRows(map: Map<string, number>): Array<{ value: string; count: number }> {
  return Array.from(map.entries())
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

export function listIncidentFacets(candidates: GroupingCandidateIncident[]): unknown {
  const services = new Map<string, number>();
  const environments = new Map<string, number>();
  const exceptionTypes = new Map<string, number>();
  const endpointHosts = new Map<string, number>();
  const endpointKinds = new Map<string, number>();
  const investigationStates = new Map<string, number>();

  for (const candidate of candidates) {
    incrementCount(services, candidate.service);
    incrementCount(investigationStates, candidate.investigation?.state);
    for (const issue of candidateIssues(candidate)) {
      incrementCount(services, issue.service);
      incrementCount(environments, environmentForResourceAttrs(issue.resourceAttrs));
      incrementCount(exceptionTypes, issue.exceptionType);
      const text = [
        issue.title,
        issue.message,
        issue.stacktrace,
        issue.resourceAttrs ? JSON.stringify(issue.resourceAttrs) : null,
        issue.logAttrs ? JSON.stringify(issue.logAttrs) : null,
      ]
        .filter((value): value is string => typeof value === "string")
        .join("\n");
      for (const host of endpointHostsFromText(text)) {
        incrementCount(endpointHosts, host);
        incrementCount(endpointKinds, endpointKind(host));
      }
    }
  }

  return {
    totalCandidates: candidates.length,
    services: mapToRows(services),
    environments: mapToRows(environments),
    exceptionTypes: mapToRows(exceptionTypes),
    endpointHosts: mapToRows(endpointHosts),
    endpointKinds: mapToRows(endpointKinds),
    investigationStates: mapToRows(investigationStates),
  };
}

export function searchCandidates(
  candidates: GroupingCandidateIncident[],
  input: unknown,
): unknown {
  const filters = parseSearchInput(input);

  const rows = candidates
    .filter((candidate) =>
      candidateMatchesFilters(candidate, {
        service: filters.service,
        environment: filters.environment,
      }),
    )
    .map((candidate) => {
      const haystack = candidateSearchText(candidate);
      const score =
        filters.tokens.length === 0
          ? 0
          : filters.tokens.reduce(
              (acc, token) => acc + (haystack.includes(token) ? 1 : 0),
              0,
            );
      return { candidate, score };
    })
    .filter((row) => filters.tokens.length === 0 || row.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return Date.parse(b.candidate.lastSeen) - Date.parse(a.candidate.lastSeen);
    })
    .slice(0, filters.limit)
    .map((row) => ({ score: row.score, ...candidatePreview(row.candidate) }));

  return {
    query: filters.query,
    service: filters.service,
    environment: filters.environment,
    returned: rows.length,
    results: rows,
  };
}

export function inspectCandidate(
  candidates: GroupingCandidateIncident[],
  input: unknown,
): unknown {
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const incidentId = typeof obj.incident_id === "string" ? obj.incident_id : "";
  const candidate = candidates.find((item) => item.id === incidentId);
  if (!candidate) return { error: `unknown incident_id: ${incidentId}` };
  return projectInspection(candidate, GROUPING_DETAIL_MESSAGE_MAX_CHARS, false);
}

function projectInspection(
  candidate: GroupingCandidateIncident,
  diagnosticMaxChars: number,
  truncated: boolean,
): unknown {
  return {
    ...candidate,
    ...(truncated ? { truncated: true } : {}),
    representative: candidate.representative
      ? {
          ...candidate.representative,
          message: compactDiagnosticText(candidate.representative.message, diagnosticMaxChars),
        }
      : null,
    issues: candidate.issues?.map((issue) => ({
      ...issue,
      message: compactDiagnosticText(issue.message, diagnosticMaxChars),
      stacktrace: issue.stacktrace
        ? compactDiagnosticText(issue.stacktrace, diagnosticMaxChars)
        : issue.stacktrace,
    })),
  };
}

// Serialize one inspection within a caller-supplied budget. A burst of
// parallel inspect calls shares a turn-level budget in the agent; preserving a
// compact head/tail from every fresh result is more useful than dropping an
// inspection the model has not seen yet.
export function inspectCandidateResult(
  candidates: GroupingCandidateIncident[],
  input: unknown,
  maxChars: number,
): string {
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const incidentId = typeof obj.incident_id === "string" ? obj.incident_id : "";
  const candidate = candidates.find((item) => item.id === incidentId);
  if (!candidate) return JSON.stringify({ error: `unknown incident_id: ${incidentId}` });

  const serialized = JSON.stringify(
    projectInspection(candidate, GROUPING_DETAIL_MESSAGE_MAX_CHARS, false),
  );
  if (serialized.length <= maxChars) return serialized;

  const diagnosticCount =
    (candidate.representative?.message ? 1 : 0) +
    (candidate.issues ?? []).reduce(
      (count, issue) => count + (issue.message ? 1 : 0) + (issue.stacktrace ? 1 : 0),
      0,
    );
  let diagnosticMaxChars = Math.min(
    GROUPING_DETAIL_MESSAGE_MAX_CHARS,
    Math.floor(maxChars / Math.max(1, diagnosticCount)),
  );
  while (diagnosticMaxChars >= 100) {
    const result = JSON.stringify(projectInspection(candidate, diagnosticMaxChars, true));
    if (result.length <= maxChars) return result;
    diagnosticMaxChars -= Math.max(
      1,
      Math.ceil((result.length - maxChars) / Math.max(1, diagnosticCount)),
    );
  }

  const envelope = (content: string) =>
    JSON.stringify({
      truncated: true,
      originalChars: serialized.length,
      content,
    });
  const emptyEnvelope = envelope("");
  let contentBudget = Math.max(0, maxChars - emptyEnvelope.length);

  while (contentBudget > 0) {
    const content = compactDiagnosticText(serialized, contentBudget) ?? "";
    const result = envelope(content);
    if (result.length <= maxChars) return result;
    contentBudget = Math.max(0, contentBudget - (result.length - maxChars));
  }

  return JSON.stringify({ truncated: true, originalChars: serialized.length });
}
