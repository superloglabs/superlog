// Thin injectable-fetch wrappers over Railway's public GraphQL API
// (backboard.railway.com/graphql/v2) — the same API that powers Railway's
// dashboard. Only the queries the connector needs, shaped for an OAuth
// `project:viewer` token:
//
//  - `externalWorkspaces` is how an OAuth app discovers what it was granted —
//    the blanket `projects` / `me.workspaces` queries are Not Authorized for
//    OAuth tokens, and the grant list is not in the token claims.
//  - `environmentLogs` reads app logs (also available as a WebSocket
//    subscription — see puller); `metrics` reads per-service infra series.
//    Both are live public-schema surface but formally undocumented, so parse
//    defensively.

import type { FetchImpl } from "./oauth.js";

export const RAILWAY_GRAPHQL_URL = "https://backboard.railway.com/graphql/v2";

export type GraphQLResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; notAuthorized: boolean };

export async function railwayGraphQL<T = unknown>(input: {
  accessToken: string;
  query: string;
  variables?: Record<string, unknown>;
  fetchImpl?: FetchImpl;
}): Promise<GraphQLResult<T>> {
  const fetchImpl = input.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(RAILWAY_GRAPHQL_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.accessToken}`,
      },
      body: JSON.stringify({ query: input.query, variables: input.variables ?? {} }),
    });
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "fetch_failed",
      notAuthorized: false,
    };
  }
  const json = (await res.json().catch(() => null)) as {
    data?: T | null;
    errors?: Array<{ message?: unknown }>;
  } | null;
  if (!json) return { ok: false, error: `status_${res.status}`, notAuthorized: false };
  if (json.errors?.length) {
    const messages = json.errors
      .map((e) => (typeof e.message === "string" ? e.message : "error"))
      .join("; ");
    return {
      ok: false,
      error: messages,
      notAuthorized: /not authorized/i.test(messages),
    };
  }
  if (!res.ok || json.data == null) {
    return { ok: false, error: `status_${res.status}`, notAuthorized: false };
  }
  return { ok: true, data: json.data };
}

// ---------------------------------------------------------------------------
// Grant discovery + inventory
// ---------------------------------------------------------------------------

export type RailwayGrantedProject = {
  id: string;
  name: string;
  workspaceId: string | null;
  workspaceName: string | null;
};

export async function fetchGrantedProjects(input: {
  accessToken: string;
  fetchImpl?: FetchImpl;
}): Promise<{ ok: true; projects: RailwayGrantedProject[] } | { ok: false; error: string }> {
  const result = await railwayGraphQL<{
    externalWorkspaces: Array<{
      id?: unknown;
      name?: unknown;
      projects?: Array<{ id?: unknown; name?: unknown }>;
    }>;
  }>({
    ...input,
    query: "query { externalWorkspaces { id name projects { id name } } }",
  });
  if (!result.ok) return { ok: false, error: result.error };
  const workspaces = Array.isArray(result.data.externalWorkspaces)
    ? result.data.externalWorkspaces
    : [];
  const projects: RailwayGrantedProject[] = [];
  for (const ws of workspaces) {
    for (const p of ws.projects ?? []) {
      if (typeof p.id !== "string" || !p.id) continue;
      projects.push({
        id: p.id,
        name: typeof p.name === "string" ? p.name : p.id,
        workspaceId: typeof ws.id === "string" ? ws.id : null,
        workspaceName: typeof ws.name === "string" ? ws.name : null,
      });
    }
  }
  return { ok: true, projects };
}

export type RailwayEnvironment = { id: string; name: string };
export type RailwayService = { id: string; name: string };

export async function fetchProjectInventory(input: {
  accessToken: string;
  projectId: string;
  fetchImpl?: FetchImpl;
}): Promise<
  | { ok: true; environments: RailwayEnvironment[]; services: RailwayService[] }
  | { ok: false; error: string }
> {
  const result = await railwayGraphQL<{
    project: {
      environments?: { edges?: Array<{ node?: { id?: unknown; name?: unknown } }> };
      services?: { edges?: Array<{ node?: { id?: unknown; name?: unknown } }> };
    } | null;
  }>({
    ...input,
    query: `query ($id: String!) {
      project(id: $id) {
        environments { edges { node { id name } } }
        services { edges { node { id name } } }
      }
    }`,
    variables: { id: input.projectId },
  });
  if (!result.ok) return { ok: false, error: result.error };
  const nodes = (
    edges: Array<{ node?: { id?: unknown; name?: unknown } }> | undefined,
  ): Array<{ id: string; name: string }> =>
    (edges ?? [])
      .map((e) => e.node)
      .filter((n): n is { id: string; name: string } => typeof n?.id === "string")
      .map((n) => ({ id: n.id, name: typeof n.name === "string" ? n.name : n.id }));
  return {
    ok: true,
    environments: nodes(result.data.project?.environments?.edges),
    services: nodes(result.data.project?.services?.edges),
  };
}

export async function fetchViewer(input: {
  accessToken: string;
  fetchImpl?: FetchImpl;
}): Promise<
  | { ok: true; viewer: { id: string; name: string | null; email: string | null } }
  | { ok: false; error: string }
> {
  const result = await railwayGraphQL<{
    me: { id?: unknown; name?: unknown; email?: unknown } | null;
  }>({ ...input, query: "query { me { id name email } }" });
  if (!result.ok) return { ok: false, error: result.error };
  const me = result.data.me;
  if (typeof me?.id !== "string" || !me.id) return { ok: false, error: "no_viewer" };
  return {
    ok: true,
    viewer: {
      id: me.id,
      name: typeof me.name === "string" ? me.name : null,
      email: typeof me.email === "string" ? me.email : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Telemetry reads
// ---------------------------------------------------------------------------

export type RailwayLog = {
  timestamp: string;
  severity: string | null;
  message: string;
  tags: {
    projectId?: string | null;
    environmentId?: string | null;
    serviceId?: string | null;
    deploymentId?: string | null;
    deploymentInstanceId?: string | null;
    snapshotId?: string | null;
  } | null;
  attributes: Array<{ key: string; value: string }>;
};

export const ENVIRONMENT_LOGS_SELECTION = `
  timestamp severity message
  tags { projectId environmentId serviceId deploymentId deploymentInstanceId snapshotId }
  attributes { key value }
`;

export async function fetchEnvironmentLogs(input: {
  accessToken: string;
  environmentId: string;
  /** Exclusive-ish lower bound; callers still dedupe against their cursor. */
  afterDate?: string;
  /** Anchor for a backwards read of the most recent lines (first pull). */
  anchorDate?: string;
  limit: number;
  filter?: string;
  fetchImpl?: FetchImpl;
}): Promise<{ ok: true; logs: RailwayLog[] } | { ok: false; error: string }> {
  const backwards = !input.afterDate;
  const result = await railwayGraphQL<{ environmentLogs: RailwayLog[] }>({
    accessToken: input.accessToken,
    fetchImpl: input.fetchImpl,
    query: backwards
      ? `query ($environmentId: String!, $filter: String!, $anchorDate: String!, $beforeLimit: Int!) {
          environmentLogs(environmentId: $environmentId, filter: $filter, anchorDate: $anchorDate, beforeLimit: $beforeLimit) { ${ENVIRONMENT_LOGS_SELECTION} }
        }`
      : `query ($environmentId: String!, $filter: String!, $afterDate: String!, $afterLimit: Int!) {
          environmentLogs(environmentId: $environmentId, filter: $filter, afterDate: $afterDate, afterLimit: $afterLimit) { ${ENVIRONMENT_LOGS_SELECTION} }
        }`,
    variables: backwards
      ? {
          environmentId: input.environmentId,
          filter: input.filter ?? "",
          anchorDate: input.anchorDate ?? new Date().toISOString(),
          beforeLimit: input.limit,
        }
      : {
          environmentId: input.environmentId,
          filter: input.filter ?? "",
          afterDate: input.afterDate,
          afterLimit: input.limit,
        },
  });
  if (!result.ok) return { ok: false, error: result.error };
  const raw = Array.isArray(result.data.environmentLogs) ? result.data.environmentLogs : [];
  return {
    ok: true,
    logs: raw.map(normalizeLog).filter((log): log is RailwayLog => log !== null),
  };
}

// environmentLogs is undocumented API surface — normalize each item instead of
// trusting the cast, so one malformed record can't abort the pull for a whole
// installation downstream (e.g. `log.attributes.map` throwing).
function normalizeLog(value: unknown): RailwayLog | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  if (typeof o.timestamp !== "string" || !o.timestamp) return null;
  const tags =
    o.tags && typeof o.tags === "object" && !Array.isArray(o.tags)
      ? (o.tags as RailwayLog["tags"])
      : null;
  const attributes = Array.isArray(o.attributes)
    ? o.attributes.filter(
        (a): a is { key: string; value: string } =>
          !!a &&
          typeof a === "object" &&
          typeof (a as { key?: unknown }).key === "string" &&
          typeof (a as { value?: unknown }).value === "string",
      )
    : [];
  return {
    timestamp: o.timestamp,
    severity: typeof o.severity === "string" ? o.severity : null,
    message: typeof o.message === "string" ? o.message : "",
    tags,
    attributes,
  };
}

export type RailwayMetricsResult = {
  measurement: string;
  values: Array<{ ts: number; value: number }>;
  tags: { serviceId?: string | null } & Record<string, unknown>;
};

/** The infra measurements the connector forwards. */
export const RAILWAY_MEASUREMENTS = [
  "CPU_USAGE",
  "MEMORY_USAGE_GB",
  "NETWORK_RX_GB",
  "NETWORK_TX_GB",
  "DISK_USAGE_GB",
] as const;

export async function fetchServiceMetrics(input: {
  accessToken: string;
  environmentId: string;
  serviceId: string;
  startDate: string;
  endDate: string;
  sampleRateSeconds: number;
  fetchImpl?: FetchImpl;
}): Promise<{ ok: true; results: RailwayMetricsResult[] } | { ok: false; error: string }> {
  const result = await railwayGraphQL<{ metrics: RailwayMetricsResult[] }>({
    accessToken: input.accessToken,
    fetchImpl: input.fetchImpl,
    query: `query ($environmentId: String!, $serviceId: String!, $startDate: DateTime!, $endDate: DateTime!, $sampleRateSeconds: Int!, $measurements: [MetricMeasurement!]!) {
      metrics(environmentId: $environmentId, serviceId: $serviceId, startDate: $startDate, endDate: $endDate, sampleRateSeconds: $sampleRateSeconds, measurements: $measurements) {
        measurement
        values { ts value }
        tags { serviceId }
      }
    }`,
    variables: {
      environmentId: input.environmentId,
      serviceId: input.serviceId,
      startDate: input.startDate,
      endDate: input.endDate,
      sampleRateSeconds: input.sampleRateSeconds,
      measurements: [...RAILWAY_MEASUREMENTS],
    },
  });
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, results: Array.isArray(result.data.metrics) ? result.data.metrics : [] };
}
