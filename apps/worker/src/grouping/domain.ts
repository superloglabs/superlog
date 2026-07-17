// Pure domain for the grouping agent: types describing an incident
// candidate / new issue, the verdict shape, and the predicates / parsers
// the agent uses to decide whether two error symptoms share a root cause.
// No I/O lives here — feed in plain objects, get plain objects back.

export type ResourceAttrs = Record<string, string> | null;

export const MIN_EVIDENCE_LENGTH = 20;
export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 25;
export const MAX_LIST_LIMIT = 200;

export type GroupingCandidateIssue = {
  id: string;
  title: string;
  service: string | null;
  exceptionType: string;
  message: string | null;
  topFrame: string | null;
  normalizedFrames: string[];
  traceId: string | null;
  spanId: string | null;
  resourceAttrs?: ResourceAttrs;
  logAttrs?: Record<string, string> | null;
  stacktrace?: string | null;
  lastSeen: string;
};

export type GroupingCandidateInvestigation = {
  id: string;
  state: string;
  createdAt: string;
  completedAt: string | null;
  selectedRepoFullName: string | null;
  result: unknown;
} | null;

export type GroupingCandidateIncident = {
  id: string;
  title: string;
  service: string | null;
  firstSeen: string;
  lastSeen: string;
  issueCount: number;
  representative: {
    exceptionType: string;
    message: string | null;
    topFrame: string | null;
    normalizedFrames: string[];
    traceId: string | null;
    spanId: string | null;
    resourceAttrs?: ResourceAttrs;
  } | null;
  issues?: GroupingCandidateIssue[];
  investigation?: GroupingCandidateInvestigation;
};

export type GroupingNewIssue = {
  id: string;
  title: string;
  service: string | null;
  exceptionType: string;
  message: string | null;
  topFrame: string | null;
  normalizedFrames: string[];
  observedAt: string;
  stacktrace: string | null;
  traceId: string | null;
  spanId: string | null;
  resourceAttrs?: ResourceAttrs;
};

export type GroupingVerdict =
  | { decision: "join"; incidentId: string; evidence: string }
  | { decision: "standalone"; evidence: string | null };

export function environmentForResourceAttrs(attrs: ResourceAttrs | undefined): string | null {
  if (!attrs) return null;
  return (
    attrs["deployment.environment"] ??
    attrs["deployment.environment.name"] ??
    attrs.environment ??
    null
  );
}

// A candidate is always expressed as a list of its constituent issues for
// downstream filtering / search. If the caller only supplied the
// representative sample (a partial shape from older callers), synthesise a
// single-element list so search/list helpers never special-case.
export function candidateIssues(candidate: GroupingCandidateIncident): GroupingCandidateIssue[] {
  if (candidate.issues?.length) return candidate.issues;
  const representative = candidate.representative;
  if (!representative) return [];
  return [
    {
      id: `${candidate.id}:representative`,
      title: candidate.title,
      service: candidate.service,
      exceptionType: representative.exceptionType,
      message: representative.message,
      topFrame: representative.topFrame,
      normalizedFrames: representative.normalizedFrames,
      traceId: representative.traceId,
      spanId: representative.spanId,
      resourceAttrs: representative.resourceAttrs ?? null,
      lastSeen: candidate.lastSeen,
    },
  ];
}

export function uniqueSorted(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => !!value))).sort();
}

export function tokenize(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9._:-]+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2),
    ),
  );
}

export function endpointHostsFromText(text: string): string[] {
  const hosts = new Set<string>();
  for (const match of text.matchAll(
    /\b(?:https?:\/\/)?((?:localhost|127\.0\.0\.1|[a-z0-9.-]+\.railway\.internal|[a-z0-9.-]+\.localhost)(?::\d+)?)/gi,
  )) {
    const host = match[1]?.toLowerCase();
    if (host) hosts.add(host);
  }
  return Array.from(hosts);
}

export function endpointKind(host: string): string {
  if (host.startsWith("localhost") || host.startsWith("127.0.0.1")) return "localhost";
  if (host.endsWith(".localhost") || host.includes(".localhost:")) return "localhost";
  if (host.includes(".railway.internal")) return "railway_internal";
  return "other";
}

export function candidateMatchesFilters(
  candidate: GroupingCandidateIncident,
  filters: { service: string | null; environment: string | null },
): boolean {
  const issues = candidateIssues(candidate);
  if (
    filters.service &&
    candidate.service !== filters.service &&
    !issues.some((issue) => issue.service === filters.service)
  ) {
    return false;
  }
  if (filters.environment) {
    const envs = [
      environmentForResourceAttrs(candidate.representative?.resourceAttrs),
      ...issues.map((issue) => environmentForResourceAttrs(issue.resourceAttrs)),
    ];
    if (!envs.includes(filters.environment)) return false;
  }
  return true;
}

export type ListFilters = {
  service: string | null;
  environment: string | null;
  limit: number;
};

export function parseListFilters(input: unknown): ListFilters {
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const service = typeof obj.service === "string" && obj.service.trim() ? obj.service.trim() : null;
  const environment =
    typeof obj.environment === "string" && obj.environment.trim() ? obj.environment.trim() : null;
  const requestedLimit =
    typeof obj.limit === "number" && Number.isFinite(obj.limit) ? obj.limit : MAX_LIST_LIMIT;
  return {
    service,
    environment,
    limit: Math.max(1, Math.min(MAX_LIST_LIMIT, Math.floor(requestedLimit))),
  };
}

export type SearchInput = {
  query: string;
  service: string | null;
  environment: string | null;
  limit: number;
  tokens: string[];
};

export function parseSearchInput(input: unknown): SearchInput {
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const query = typeof obj.query === "string" ? obj.query : "";
  const service = typeof obj.service === "string" && obj.service.trim() ? obj.service.trim() : null;
  const environment =
    typeof obj.environment === "string" && obj.environment.trim() ? obj.environment.trim() : null;
  const requestedLimit =
    typeof obj.limit === "number" && Number.isFinite(obj.limit) ? obj.limit : DEFAULT_SEARCH_LIMIT;
  return {
    query,
    service,
    environment,
    limit: Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.floor(requestedLimit))),
    tokens: tokenize(query),
  };
}

// Standalone text the LLM-text fallback parser checks. Distinct from the
// structured tool-input parser because the model can opt out of tools and
// reply with raw JSON — we still want to honour a valid verdict in that case.
export function parseVerdictFromText(
  raw: string,
  candidateIds: ReadonlySet<string>,
): GroupingVerdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { decision: "standalone", evidence: null };
  }
  return interpretVerdictPayload(parsed, candidateIds);
}

function interpretVerdictPayload(
  parsed: unknown,
  candidateIds: ReadonlySet<string>,
): GroupingVerdict {
  if (!parsed || typeof parsed !== "object") {
    return { decision: "standalone", evidence: null };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.decision === "join") {
    const incidentId = typeof obj.incidentId === "string" ? obj.incidentId : "";
    const evidence = typeof obj.evidence === "string" ? obj.evidence.trim() : "";
    if (candidateIds.has(incidentId) && evidence.length >= MIN_EVIDENCE_LENGTH) {
      return { decision: "join", incidentId, evidence };
    }
    return { decision: "standalone", evidence: null };
  }
  const evidence =
    typeof obj.evidence === "string" && obj.evidence.trim().length > 0
      ? obj.evidence.trim()
      : null;
  return { decision: "standalone", evidence };
}

// Used to parse the structured `decide_grouping` tool input. Returns null
// when the input shape is unusable — the agent will see an is_error
// tool_result and can try again.
export function parseDecisionToolInput(
  input: unknown,
  candidateIds: ReadonlySet<string>,
): GroupingVerdict | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const evidence =
    typeof obj.evidence === "string" && obj.evidence.trim().length > 0
      ? obj.evidence.trim()
      : null;
  if (obj.decision === "join") {
    const incidentId = typeof obj.incidentId === "string" ? obj.incidentId : "";
    if (
      candidateIds.has(incidentId) &&
      typeof evidence === "string" &&
      evidence.length >= MIN_EVIDENCE_LENGTH
    ) {
      return { decision: "join", incidentId, evidence };
    }
    return { decision: "standalone", evidence: null };
  }
  if (obj.decision === "standalone") return { decision: "standalone", evidence };
  return null;
}
