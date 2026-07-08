// Thin injectable-fetch wrappers over Render's public REST API
// (api.render.com/v1) — the documented API that powers Render's dashboard.
// Unlike Railway there is no third-party OAuth: Render integrations
// authenticate with a user-created API key (Account settings → API Keys),
// sent as a Bearer token. A key grants access to every workspace the creating
// user belongs to, so the connect flow asks the user to pick one workspace
// (`ownerId`) and the connector only ever reads within it.
//
// Only the endpoints the connector needs:
//  - GET /owners      — workspaces visible to the key (connect-time picker)
//  - GET /services    — service inventory for the chosen workspace
//  - GET /logs        — pull logs across resources (timestamp-paginated)
//  - GET /metrics/*   — infra series (cpu, memory, instance count, …)
//
// Rate limits are per user key: logs endpoints 30 req/min, other GETs
// 400 req/min — the puller batches resources per request to stay well under.

export const RENDER_API_URL = "https://api.render.com/v1";

// Overridable for integration tests / local fakes; every caller of this
// package runs in node (api + worker), so process.env is always there.
function apiBaseUrl(): string {
  return process.env.RENDER_API_URL || RENDER_API_URL;
}

export type FetchImpl = typeof fetch;

export type RenderResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status: number | null; unauthorized: boolean };

async function renderRequest<T = unknown>(input: {
  apiKey: string;
  path: string;
  method?: string;
  body?: unknown;
  query?: URLSearchParams;
  fetchImpl?: FetchImpl;
}): Promise<RenderResult<T>> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const qs = input.query?.toString();
  const url = `${apiBaseUrl()}${input.path}${qs ? `?${qs}` : ""}`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: input.method ?? "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.apiKey}`,
        ...(input.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    });
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "fetch_failed",
      status: null,
      unauthorized: false,
    };
  }
  const json = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const message =
      json &&
      typeof json === "object" &&
      typeof (json as { message?: unknown }).message === "string"
        ? (json as { message: string }).message
        : `status_${res.status}`;
    return {
      ok: false,
      error: message,
      status: res.status,
      unauthorized: res.status === 401 || res.status === 403,
    };
  }
  // Some write endpoints answer with an empty body (e.g. DELETE → 204);
  // an OK status with no JSON is still a success.
  return { ok: true, data: json as T };
}

// ---------------------------------------------------------------------------
// Workspace + service inventory
// ---------------------------------------------------------------------------

export type RenderOwner = {
  id: string;
  name: string;
  email: string | null;
  type: "user" | "team" | string;
};

/**
 * Workspaces the API key can see — the connect-time picker. Also doubles as
 * key validation: an invalid key comes back `unauthorized`.
 */
export async function fetchOwners(input: {
  apiKey: string;
  fetchImpl?: FetchImpl;
}): Promise<
  { ok: true; owners: RenderOwner[] } | { ok: false; error: string; unauthorized: boolean }
> {
  const owners: RenderOwner[] = [];
  let cursor: string | null = null;
  // Render lists are cursor-paginated with items wrapped as { owner, cursor }.
  for (let page = 0; page < 10; page++) {
    const query = new URLSearchParams({ limit: "100" });
    if (cursor) query.set("cursor", cursor);
    const result = await renderRequest<Array<{ owner?: unknown; cursor?: unknown }>>({
      apiKey: input.apiKey,
      path: "/owners",
      query,
      fetchImpl: input.fetchImpl,
    });
    if (!result.ok) return { ok: false, error: result.error, unauthorized: result.unauthorized };
    const items = Array.isArray(result.data) ? result.data : [];
    for (const item of items) {
      const owner = normalizeOwner(item?.owner);
      if (owner) owners.push(owner);
    }
    if (items.length < 100) break;
    const last = items[items.length - 1];
    cursor = typeof last?.cursor === "string" && last.cursor ? last.cursor : null;
    if (!cursor) break;
  }
  return { ok: true, owners };
}

function normalizeOwner(value: unknown): RenderOwner | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id) return null;
  return {
    id: o.id,
    name: typeof o.name === "string" && o.name ? o.name : o.id,
    email: typeof o.email === "string" && o.email ? o.email : null,
    type: typeof o.type === "string" && o.type ? o.type : "user",
  };
}

export type RenderService = {
  id: string;
  name: string;
  type: string;
  /** Deploy region (e.g. "oregon"); null when the API omits it (static sites). */
  region: string | null;
  suspended: boolean;
};

/** Service inventory for one workspace, cursor-paginated. */
export async function fetchServices(input: {
  apiKey: string;
  ownerId: string;
  fetchImpl?: FetchImpl;
}): Promise<
  { ok: true; services: RenderService[] } | { ok: false; error: string; unauthorized: boolean }
> {
  const services: RenderService[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const query = new URLSearchParams({ ownerId: input.ownerId, limit: "100" });
    if (cursor) query.set("cursor", cursor);
    const result = await renderRequest<Array<{ service?: unknown; cursor?: unknown }>>({
      apiKey: input.apiKey,
      path: "/services",
      query,
      fetchImpl: input.fetchImpl,
    });
    if (!result.ok) return { ok: false, error: result.error, unauthorized: result.unauthorized };
    const items = Array.isArray(result.data) ? result.data : [];
    for (const item of items) {
      const service = normalizeService(item?.service);
      if (service) services.push(service);
    }
    if (items.length < 100) break;
    const last = items[items.length - 1];
    cursor = typeof last?.cursor === "string" && last.cursor ? last.cursor : null;
    if (!cursor) break;
  }
  return { ok: true, services };
}

function normalizeService(value: unknown): RenderService | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id) return null;
  const details =
    o.serviceDetails && typeof o.serviceDetails === "object"
      ? (o.serviceDetails as Record<string, unknown>)
      : null;
  const region =
    typeof details?.region === "string" && details.region
      ? details.region
      : typeof o.region === "string" && o.region
        ? o.region
        : null;
  return {
    id: o.id,
    name: typeof o.name === "string" && o.name ? o.name : o.id,
    type: typeof o.type === "string" && o.type ? o.type : "unknown",
    region,
    suspended: o.suspended === "suspended",
  };
}

// ---------------------------------------------------------------------------
// Telemetry reads
// ---------------------------------------------------------------------------

export type RenderLog = {
  id: string | null;
  timestamp: string;
  message: string;
  /** Render's log metadata: resource, instance, level, type, host, … */
  labels: Array<{ name: string; value: string }>;
};

export type RenderLogsPage = {
  logs: RenderLog[];
  hasMore: boolean;
  nextStartTime: string | null;
  nextEndTime: string | null;
};

/**
 * One page of logs across resources (must share the workspace and region).
 * Timestamp-paginated: pass the returned nextStartTime/nextEndTime back to
 * fetch the following page while `hasMore`.
 */
export async function fetchLogs(input: {
  apiKey: string;
  ownerId: string;
  resources: string[];
  startTime?: string;
  endTime?: string;
  direction?: "forward" | "backward";
  limit: number;
  fetchImpl?: FetchImpl;
}): Promise<
  { ok: true; page: RenderLogsPage } | { ok: false; error: string; unauthorized: boolean }
> {
  const query = new URLSearchParams({ ownerId: input.ownerId, limit: String(input.limit) });
  for (const resource of input.resources) query.append("resource", resource);
  if (input.startTime) query.set("startTime", input.startTime);
  if (input.endTime) query.set("endTime", input.endTime);
  if (input.direction) query.set("direction", input.direction);
  const result = await renderRequest<{
    logs?: unknown;
    hasMore?: unknown;
    nextStartTime?: unknown;
    nextEndTime?: unknown;
  }>({ apiKey: input.apiKey, path: "/logs", query, fetchImpl: input.fetchImpl });
  if (!result.ok) return { ok: false, error: result.error, unauthorized: result.unauthorized };
  const raw = Array.isArray(result.data.logs) ? result.data.logs : [];
  return {
    ok: true,
    page: {
      logs: raw.map(normalizeLog).filter((log): log is RenderLog => log !== null),
      hasMore: result.data.hasMore === true,
      nextStartTime:
        typeof result.data.nextStartTime === "string" && result.data.nextStartTime
          ? result.data.nextStartTime
          : null,
      nextEndTime:
        typeof result.data.nextEndTime === "string" && result.data.nextEndTime
          ? result.data.nextEndTime
          : null,
    },
  };
}

// Normalize each item instead of trusting the cast, so one malformed record
// can't abort the pull for a whole installation downstream.
function normalizeLog(value: unknown): RenderLog | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  if (typeof o.timestamp !== "string" || !o.timestamp) return null;
  const labels = Array.isArray(o.labels)
    ? o.labels.filter(
        (l): l is { name: string; value: string } =>
          !!l &&
          typeof l === "object" &&
          typeof (l as { name?: unknown }).name === "string" &&
          typeof (l as { value?: unknown }).value === "string",
      )
    : [];
  return {
    id: typeof o.id === "string" && o.id ? o.id : null,
    timestamp: o.timestamp,
    message: typeof o.message === "string" ? o.message : "",
    labels,
  };
}

/** The infra series the connector forwards, one GET /metrics/<kind> each. */
export const RENDER_METRIC_KINDS = [
  "cpu",
  "memory",
  "instance-count",
  "bandwidth",
  "disk-usage",
] as const;

export type RenderMetricKind = (typeof RENDER_METRIC_KINDS)[number];

export type RenderMetricSeries = {
  labels: Array<{ field: string; value: string }>;
  unit: string | null;
  values: Array<{ timestamp: string; value: number }>;
};

/** One metrics kind for a batch of resources; series come back labeled. */
export async function fetchMetrics(input: {
  apiKey: string;
  kind: RenderMetricKind;
  resources: string[];
  startTime: string;
  endTime: string;
  resolutionSeconds: number;
  fetchImpl?: FetchImpl;
}): Promise<
  { ok: true; series: RenderMetricSeries[] } | { ok: false; error: string; unauthorized: boolean }
> {
  const query = new URLSearchParams({
    startTime: input.startTime,
    endTime: input.endTime,
    resolutionSeconds: String(input.resolutionSeconds),
  });
  for (const resource of input.resources) query.append("resource", resource);
  const result = await renderRequest<unknown[]>({
    apiKey: input.apiKey,
    path: `/metrics/${input.kind}`,
    query,
    fetchImpl: input.fetchImpl,
  });
  if (!result.ok) return { ok: false, error: result.error, unauthorized: result.unauthorized };
  const raw = Array.isArray(result.data) ? result.data : [];
  return {
    ok: true,
    series: raw.map(normalizeSeries).filter((s): s is RenderMetricSeries => s !== null),
  };
}

function normalizeSeries(value: unknown): RenderMetricSeries | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  const labels = Array.isArray(o.labels)
    ? o.labels.filter(
        (l): l is { field: string; value: string } =>
          !!l &&
          typeof l === "object" &&
          typeof (l as { field?: unknown }).field === "string" &&
          typeof (l as { value?: unknown }).value === "string",
      )
    : [];
  const values = Array.isArray(o.values)
    ? o.values.filter(
        (v): v is { timestamp: string; value: number } =>
          !!v &&
          typeof v === "object" &&
          typeof (v as { timestamp?: unknown }).timestamp === "string" &&
          typeof (v as { value?: unknown }).value === "number" &&
          Number.isFinite((v as { value: number }).value),
      )
    : [];
  return {
    labels,
    unit: typeof o.unit === "string" && o.unit ? o.unit : null,
    values,
  };
}

/** The resource a series describes, from its labels (field varies by kind). */
export function seriesResourceId(series: RenderMetricSeries): string | null {
  for (const field of ["resource", "service", "server"]) {
    const label = series.labels.find((l) => l.field === field);
    if (label?.value) return label.value;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Telemetry streams (push). A workspace has ONE log stream and ONE metrics
// stream destination — the connector must never silently overwrite a
// destination it doesn't own, so provisioning reads the current setting first
// (see apps/api's provisioning flow).
//  - Log streams push JSON over HTTPS (or RFC5424 syslog; we register HTTPS).
//  - Metrics streams push OTLP JSON with the token as a bearer header
//    (provider CUSTOM). Pro-plan workspaces and up only.
// ---------------------------------------------------------------------------

export type RenderLogStreamSetting = {
  endpoint: string | null;
  /** "send" streams logs; "drop" disables the stream without deleting it. */
  preview: string | null;
};

export async function fetchOwnerLogStream(input: {
  apiKey: string;
  ownerId: string;
  fetchImpl?: FetchImpl;
}): Promise<
  | { ok: true; stream: RenderLogStreamSetting | null }
  | { ok: false; error: string; unauthorized: boolean }
> {
  const result = await renderRequest<{ endpoint?: unknown; preview?: unknown }>({
    apiKey: input.apiKey,
    path: `/logs/streams/owner/${encodeURIComponent(input.ownerId)}`,
    fetchImpl: input.fetchImpl,
  });
  if (!result.ok) {
    // No stream configured yet reads as absent, not as an error.
    if (result.status === 404) return { ok: true, stream: null };
    return { ok: false, error: result.error, unauthorized: result.unauthorized };
  }
  const o = result.data;
  if (!o || typeof o !== "object") return { ok: true, stream: null };
  return {
    ok: true,
    stream: {
      endpoint: typeof o.endpoint === "string" && o.endpoint ? o.endpoint : null,
      preview: typeof o.preview === "string" && o.preview ? o.preview : null,
    },
  };
}

export async function updateOwnerLogStream(input: {
  apiKey: string;
  ownerId: string;
  endpoint: string;
  token: string;
  fetchImpl?: FetchImpl;
}): Promise<{ ok: true } | { ok: false; error: string; unauthorized: boolean }> {
  const result = await renderRequest({
    apiKey: input.apiKey,
    path: `/logs/streams/owner/${encodeURIComponent(input.ownerId)}`,
    method: "PUT",
    body: { preview: "send", endpoint: input.endpoint, token: input.token },
    fetchImpl: input.fetchImpl,
  });
  if (!result.ok) return { ok: false, error: result.error, unauthorized: result.unauthorized };
  return { ok: true };
}

export async function deleteOwnerLogStream(input: {
  apiKey: string;
  ownerId: string;
  fetchImpl?: FetchImpl;
}): Promise<{ ok: true } | { ok: false; error: string; unauthorized: boolean }> {
  const result = await renderRequest({
    apiKey: input.apiKey,
    path: `/logs/streams/owner/${encodeURIComponent(input.ownerId)}`,
    method: "DELETE",
    fetchImpl: input.fetchImpl,
  });
  if (!result.ok && result.status !== 404) {
    return { ok: false, error: result.error, unauthorized: result.unauthorized };
  }
  return { ok: true };
}

export type RenderMetricsStreamSetting = {
  provider: string | null;
  url: string | null;
};

export async function fetchOwnerMetricsStream(input: {
  apiKey: string;
  ownerId: string;
  fetchImpl?: FetchImpl;
}): Promise<
  | { ok: true; stream: RenderMetricsStreamSetting | null }
  | { ok: false; error: string; unauthorized: boolean }
> {
  const result = await renderRequest<{ provider?: unknown; url?: unknown }>({
    apiKey: input.apiKey,
    path: `/metrics-stream/${encodeURIComponent(input.ownerId)}`,
    fetchImpl: input.fetchImpl,
  });
  if (!result.ok) {
    if (result.status === 404) return { ok: true, stream: null };
    return { ok: false, error: result.error, unauthorized: result.unauthorized };
  }
  const o = result.data;
  if (!o || typeof o !== "object") return { ok: true, stream: null };
  const url = typeof o.url === "string" && o.url ? o.url : null;
  if (!url) return { ok: true, stream: null };
  return {
    ok: true,
    stream: { provider: typeof o.provider === "string" ? o.provider : null, url },
  };
}

export async function upsertOwnerMetricsStream(input: {
  apiKey: string;
  ownerId: string;
  url: string;
  token: string;
  fetchImpl?: FetchImpl;
}): Promise<
  { ok: true } | { ok: false; error: string; unauthorized: boolean; status: number | null }
> {
  const result = await renderRequest({
    apiKey: input.apiKey,
    path: `/metrics-stream/${encodeURIComponent(input.ownerId)}`,
    method: "PUT",
    body: { provider: "CUSTOM", url: input.url, token: input.token },
    fetchImpl: input.fetchImpl,
  });
  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      unauthorized: result.unauthorized,
      status: result.status,
    };
  }
  return { ok: true };
}

export async function deleteOwnerMetricsStream(input: {
  apiKey: string;
  ownerId: string;
  fetchImpl?: FetchImpl;
}): Promise<{ ok: true } | { ok: false; error: string; unauthorized: boolean }> {
  const result = await renderRequest({
    apiKey: input.apiKey,
    path: `/metrics-stream/${encodeURIComponent(input.ownerId)}`,
    method: "DELETE",
    fetchImpl: input.fetchImpl,
  });
  if (!result.ok && result.status !== 404) {
    return { ok: false, error: result.error, unauthorized: result.unauthorized };
  }
  return { ok: true };
}
