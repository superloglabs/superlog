// Pure helpers + thin (injectable-fetch) HTTP wrappers for the Cloudflare
// integration. Cloudflare shipped self-managed OAuth for all developers in
// 2026-06, so we can offer a Slack-style "Connect Cloudflare" button: the user
// consents, and we use the granted token to create Workers Observability
// "telemetry destinations" that export OTLP traces/logs/metrics straight to our
// intake — no copy-paste API tokens.
//
// OAuth endpoints (from Cloudflare's "Integrate your OAuth client" docs):
//   authorize: https://dash.cloudflare.com/oauth2/auth
//   token:     https://dash.cloudflare.com/oauth2/token
//   revoke:    https://dash.cloudflare.com/oauth2/revoke
//
// This module is deliberately IO-light: everything is a pure function or a
// wrapper that takes an injectable `fetch`, so the route layer (cloudflare.ts)
// stays thin and the logic is unit-testable without a live Cloudflare account.

import crypto from "node:crypto";

export const CLOUDFLARE_OAUTH_AUTHORIZE_URL = "https://dash.cloudflare.com/oauth2/auth";
export const CLOUDFLARE_OAUTH_TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";
export const CLOUDFLARE_OAUTH_REVOKE_URL = "https://dash.cloudflare.com/oauth2/revoke";
export const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

// Cloudflare OAuth scope identifiers (dot-delimited, mirroring API-token
// permission names — verified against `GET /client/v4/oauth/scopes`). The
// connector needs to:
//   - account-settings.read            list the account (resolve the account id)
//   - workers-observability(.write)    create the telemetry destinations
//   - workers-observability-telemetry.write   (destinations live under this perm)
//   - workers-scripts.read/.write      read each Worker's observability config
//                                      and wire our destinations into it
// Override with CLOUDFLARE_OAUTH_SCOPES if a deployment's client differs.
// `offline_access` is added/removed automatically by Cloudflare based on the
// client's grant types, so we don't list it here.
export const DEFAULT_CLOUDFLARE_OAUTH_SCOPES = [
  "account-settings.read",
  "workers-observability.write",
  "workers-observability-telemetry.write",
  "workers-scripts.read",
  "workers-scripts.write",
];

export type CloudflareSignal = "traces" | "logs" | "metrics";

// signal → { Cloudflare Logpush dataset name, our OTLP path }. Cloudflare's
// Workers Observability destinations are modelled as Logpush jobs with an
// `opentelemetry-*` dataset that emits OTLP to the configured URL.
export const CLOUDFLARE_OTLP_SIGNALS: Record<CloudflareSignal, { dataset: string; path: string }> =
  {
    traces: { dataset: "opentelemetry-traces", path: "/v1/traces" },
    logs: { dataset: "opentelemetry-logs", path: "/v1/logs" },
    metrics: { dataset: "opentelemetry-metrics", path: "/v1/metrics" },
  };

export const CLOUDFLARE_SIGNALS: CloudflareSignal[] = ["traces", "logs", "metrics"];

export type CloudflareConnectConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
  /**
   * Base URL of our public OTLP intake (trailing slash stripped), e.g.
   * `https://intake.superlog.sh`. Created destinations target
   * `${intakeBaseUrl}/v1/{traces,logs,metrics}`.
   */
  intakeBaseUrl: string;
};

/** Read connector config from env; null (→ feature disabled) when unconfigured. */
export function cloudflareConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CloudflareConnectConfig | null {
  const clientId = env.CLOUDFLARE_CLIENT_ID;
  const clientSecret = env.CLOUDFLARE_CLIENT_SECRET;
  const intake = env.CLOUDFLARE_OTLP_INTAKE_URL;
  if (!clientId || !clientSecret || !intake) return null;
  const redirectUri =
    env.CLOUDFLARE_OAUTH_REDIRECT_URL ?? "http://localhost:4100/cloudflare/oauth/callback";
  const scopes = env.CLOUDFLARE_OAUTH_SCOPES?.trim()
    ? env.CLOUDFLARE_OAUTH_SCOPES.trim().split(/\s+/)
    : DEFAULT_CLOUDFLARE_OAUTH_SCOPES;
  return {
    clientId,
    clientSecret,
    redirectUri,
    scopes,
    intakeBaseUrl: intake.replace(/\/+$/, ""),
  };
}

export function buildAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
}): string {
  const url = new URL(CLOUDFLARE_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", input.scopes.join(" "));
  url.searchParams.set("state", input.state);
  return url.toString();
}

export function intakeUrlForSignal(base: string, signal: CloudflareSignal): string {
  return `${base.replace(/\/+$/, "")}${CLOUDFLARE_OTLP_SIGNALS[signal].path}`;
}

export type DestinationPayload = {
  name: string;
  enabled: boolean;
  // Skip Cloudflare's create-time reachability probe. The probe is a Logpush-style
  // test request against the destination URL; our intake speaks OTLP and rejects
  // it, which fails the create even though the real OTLP export path works. We own
  // the intake and mint the key here, so the probe adds nothing but a failure mode.
  skipPreflightCheck: boolean;
  configuration: {
    type: "logpush";
    logpushDataset: string;
    url: string;
    headers: Record<string, string>;
  };
};

/**
 * Build the Workers Observability destination payload for one signal: a Logpush
 * destination with the matching `opentelemetry-*` dataset, pointed at our intake
 * and authenticated with the project's ingest key via `x-api-key`.
 *
 * The destination `name` must match Cloudflare's `^[a-z0-9-]+$` rule (lowercase
 * letters, numbers, hyphens), so it's `superlog-<signal>` — not a display string.
 */
export function buildDestinationPayload(input: {
  signal: CloudflareSignal;
  intakeBaseUrl: string;
  ingestKey: string;
}): DestinationPayload {
  const sig = CLOUDFLARE_OTLP_SIGNALS[input.signal];
  return {
    name: `superlog-${input.signal}`,
    enabled: true,
    skipPreflightCheck: true,
    configuration: {
      type: "logpush",
      logpushDataset: sig.dataset,
      url: intakeUrlForSignal(input.intakeBaseUrl, input.signal),
      headers: { "x-api-key": input.ingestKey },
    },
  };
}

// ---------------------------------------------------------------------------
// OAuth state (signed, short-lived) — mirrors the Slack connector's scheme so
// the callback can trust org/project/user without a session cookie.
// ---------------------------------------------------------------------------

export type CloudflareStatePayload = {
  orgId: string;
  projectId: string;
  userId: string | null;
};

export function signState(p: CloudflareStatePayload, secret: string): string {
  const body = `${p.orgId}.${p.projectId}.${p.userId ?? ""}.${Date.now()}`;
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${Buffer.from(body, "utf8").toString("base64url")}.${sig}`;
}

export function verifyState(state: string, secret: string): CloudflareStatePayload | null {
  const [payloadB64, sig] = state.split(".");
  if (!payloadB64 || !sig) return null;
  const body = Buffer.from(payloadB64, "base64url").toString("utf8");
  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  const provided = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (provided.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(provided, expectedBuf)) return null;
  const parts = body.split(".");
  if (parts.length !== 4) return null;
  const [orgId, projectId, userId, tsRaw] = parts as [string, string, string, string];
  if (!orgId || !projectId || !tsRaw) return null;
  const ts = Number(tsRaw);
  if (!Number.isFinite(ts) || Date.now() - ts > 10 * 60 * 1000) return null;
  return { orgId, projectId, userId: userId || null };
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

export type CloudflareTokenResult =
  | {
      ok: true;
      accessToken: string;
      refreshToken: string | null;
      expiresIn: number | null;
      scope: string | null;
    }
  | { ok: false; error: string };

export function parseTokenResponse(json: unknown): CloudflareTokenResult {
  if (!json || typeof json !== "object") return { ok: false, error: "invalid_response" };
  const o = json as Record<string, unknown>;
  if (typeof o.error === "string") {
    return { ok: false, error: o.error };
  }
  if (typeof o.access_token !== "string" || !o.access_token) {
    return { ok: false, error: "no_access_token" };
  }
  return {
    ok: true,
    accessToken: o.access_token,
    refreshToken: typeof o.refresh_token === "string" ? o.refresh_token : null,
    expiresIn: typeof o.expires_in === "number" ? o.expires_in : null,
    scope: typeof o.scope === "string" ? o.scope : null,
  };
}

export type CloudflareAccount = { id: string; name: string };

/** Parse `GET /accounts` → `{ success, result: [{ id, name }] }`. */
export function parseAccountsResponse(json: unknown): CloudflareAccount[] {
  if (!json || typeof json !== "object") return [];
  const result = (json as Record<string, unknown>).result;
  if (!Array.isArray(result)) return [];
  const accounts: CloudflareAccount[] = [];
  for (const item of result) {
    if (item && typeof item === "object") {
      const id = (item as Record<string, unknown>).id;
      const name = (item as Record<string, unknown>).name;
      if (typeof id === "string" && id) {
        accounts.push({ id, name: typeof name === "string" ? name : "" });
      }
    }
  }
  return accounts;
}

export type CreateDestinationResult =
  | { ok: true; slug: string | null }
  | { ok: false; error: string };

/**
 * Pull a human-readable error out of a failed create-destination response.
 * Cloudflare uses two shapes here: the standard envelope `{errors:[{message}]}`,
 * and — for request-body validation — a Zod error `{error:{name, issues:[{message,
 * path}]}}` (mirrored as `_error`). We surface both so a validation failure (e.g.
 * an invalid destination name) isn't flattened to a generic "request_failed".
 */
function extractCreateError(o: Record<string, unknown>): string {
  const errors = Array.isArray(o.errors) ? o.errors : [];
  const first = errors[0] as Record<string, unknown> | undefined;
  if (first && typeof first.message === "string") return first.message;

  const zod = (o.error ?? o._error) as Record<string, unknown> | undefined;
  if (zod && typeof zod === "object") {
    const issues = Array.isArray(zod.issues) ? zod.issues : [];
    const msgs = issues
      .map((i) => (i as Record<string, unknown>)?.message)
      .filter((m): m is string => typeof m === "string");
    if (msgs.length > 0) return msgs.join("; ");
    if (typeof zod.name === "string") return zod.name;
  }
  return "request_failed";
}

/** Parse the create-destination response → `{ success, result: { slug } }`. */
export function parseCreateDestinationResponse(json: unknown): CreateDestinationResult {
  if (!json || typeof json !== "object") return { ok: false, error: "invalid_response" };
  const o = json as Record<string, unknown>;
  // Require an explicit `success: true`. Cloudflare's API envelope always sets
  // it, so treat anything else (success:false, or a malformed/partial response
  // that omits it) as a failure — otherwise an error body could be recorded as a
  // provisioned destination with an empty slug.
  if (o.success !== true) {
    return { ok: false, error: extractCreateError(o) };
  }
  const result = o.result;
  const slug =
    result &&
    typeof result === "object" &&
    typeof (result as Record<string, unknown>).slug === "string"
      ? ((result as Record<string, unknown>).slug as string)
      : null;
  return { ok: true, slug };
}

/**
 * Given the prior same-account destinations and the ones we just (re)created,
 * return the prior slugs that are now stale and should be deleted remotely.
 *
 * Two guards keep a partial reconnect from dropping working telemetry:
 *  - Only signals that actually got a fresh destination this run (`signal in
 *    current`) are eligible — a signal whose recreate FAILED keeps its prior
 *    destination, since deleting it would leave that signal with nothing.
 *  - A prior slug that's still present in the new set is kept (Cloudflare's
 *    create can be upsert-by-name and return the same slug — that's the live
 *    destination, not a stale duplicate).
 */
export function staleDestinationSlugs(
  previous: Record<string, string> | null | undefined,
  current: Record<string, string>,
): Record<string, string> {
  if (!previous) return {};
  const liveSlugs = new Set(Object.values(current));
  return Object.fromEntries(
    Object.entries(previous).filter(([signal, slug]) => signal in current && !liveSlugs.has(slug)),
  );
}

// ---------------------------------------------------------------------------
// Worker observability wiring
//
// Creating a destination is not enough: a Worker only exports to a destination
// when its own `observability` config enables the signal and lists the
// destination by name. So on connect we read each Worker's settings and merge our
// destination slugs in.
// ---------------------------------------------------------------------------

export type WorkerObservabilitySignal = {
  enabled?: boolean;
  destinations?: string[];
  [k: string]: unknown;
};
export type WorkerObservability = {
  enabled?: boolean;
  logs?: WorkerObservabilitySignal;
  traces?: WorkerObservabilitySignal;
  [k: string]: unknown;
};

/** signal → the Worker `observability` sub-key it maps to (metrics isn't a Worker signal). */
const WORKER_OBSERVABILITY_SIGNALS = ["logs", "traces"] as const;

/**
 * Merge our destination slugs into a Worker's existing observability config so it
 * exports the matching signals to our intake. Additive and idempotent: turns on
 * observability and each wired signal, and appends our slug to that signal's
 * `destinations` without dropping the Worker's existing destinations, sampling
 * rates, or any other fields. Returns the updated config, or `null` when the
 * Worker is already wired (nothing to change) so the caller can skip the PATCH.
 *
 * `slugs` maps our signal name (traces/logs) to the destination slug we created;
 * metrics is omitted because Workers Observability has no per-Worker metrics
 * signal.
 */
export function wireObservabilityDestinations(
  current: WorkerObservability | null | undefined,
  slugs: { traces?: string; logs?: string },
): WorkerObservability | null {
  const next: WorkerObservability = current ? { ...current } : {};
  let changed = false;
  if (next.enabled !== true) {
    next.enabled = true;
    changed = true;
  }
  for (const signal of WORKER_OBSERVABILITY_SIGNALS) {
    const slug = slugs[signal];
    if (!slug) continue;
    const sig: WorkerObservabilitySignal = { ...(next[signal] ?? {}) };
    const destinations = Array.isArray(sig.destinations) ? [...sig.destinations] : [];
    if (sig.enabled !== true) {
      sig.enabled = true;
      changed = true;
    }
    if (!destinations.includes(slug)) {
      destinations.push(slug);
      changed = true;
    }
    sig.destinations = destinations;
    next[signal] = sig;
  }
  return changed ? next : null;
}

// ---------------------------------------------------------------------------
// HTTP wrappers (injectable fetch)
// ---------------------------------------------------------------------------

export type FetchImpl = typeof fetch;

export async function exchangeCodeForToken(input: {
  config: CloudflareConnectConfig;
  code: string;
  fetchImpl?: FetchImpl;
}): Promise<CloudflareTokenResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const res = await fetchImpl(CLOUDFLARE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.config.redirectUri,
      client_id: input.config.clientId,
      client_secret: input.config.clientSecret,
    }),
  });
  const json = await res.json().catch(() => null);
  return parseTokenResponse(json);
}

export async function listAccounts(
  accessToken: string,
  fetchImpl: FetchImpl = fetch,
): Promise<CloudflareAccount[]> {
  const res = await fetchImpl(`${CLOUDFLARE_API_BASE}/accounts`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const json = await res.json().catch(() => null);
  return parseAccountsResponse(json);
}

export async function createDestination(input: {
  accountId: string;
  accessToken: string;
  payload: DestinationPayload;
  fetchImpl?: FetchImpl;
}): Promise<CreateDestinationResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const res = await fetchImpl(
    `${CLOUDFLARE_API_BASE}/accounts/${input.accountId}/workers/observability/destinations`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.accessToken}`,
      },
      body: JSON.stringify(input.payload),
    },
  );
  const json = await res.json().catch(() => null);
  return parseCreateDestinationResponse(json);
}

/**
 * Delete a Workers Observability destination by slug. Best-effort (used when
 * superseding a prior connect so we don't leave duplicate remote destinations
 * streaming): never throws, returns whether Cloudflare accepted the delete.
 */
export async function deleteDestination(input: {
  accountId: string;
  accessToken: string;
  slug: string;
  fetchImpl?: FetchImpl;
}): Promise<{ ok: boolean }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(
      `${CLOUDFLARE_API_BASE}/accounts/${input.accountId}/workers/observability/destinations/${encodeURIComponent(
        input.slug,
      )}`,
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${input.accessToken}` },
      },
    );
    return { ok: res.ok };
  } catch {
    return { ok: false };
  }
}

/** Best-effort token revoke (used on uninstall). Never throws. */
export async function revokeToken(input: {
  config: CloudflareConnectConfig;
  token: string;
  fetchImpl?: FetchImpl;
}): Promise<void> {
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    await fetchImpl(CLOUDFLARE_OAUTH_REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: input.token,
        client_id: input.config.clientId,
        client_secret: input.config.clientSecret,
      }),
    });
  } catch {
    // best-effort
  }
}

/** Parse `GET /workers/scripts` → list of script (Worker) ids. */
export function parseScriptsResponse(json: unknown): string[] {
  if (!json || typeof json !== "object") return [];
  const result = (json as Record<string, unknown>).result;
  if (!Array.isArray(result)) return [];
  const ids: string[] = [];
  for (const item of result) {
    const id = item && typeof item === "object" ? (item as Record<string, unknown>).id : null;
    if (typeof id === "string" && id) ids.push(id);
  }
  return ids;
}

/** List the Worker script ids in an account. Returns [] on any failure. */
export async function listScripts(
  accountId: string,
  accessToken: string,
  fetchImpl: FetchImpl = fetch,
): Promise<string[]> {
  const res = await fetchImpl(`${CLOUDFLARE_API_BASE}/accounts/${accountId}/workers/scripts`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const json = await res.json().catch(() => null);
  return parseScriptsResponse(json);
}

/**
 * Read one Worker's `observability` config. Returns `null` only on a *successful*
 * read where observability is unset (a genuinely fresh Worker). A failed read
 * (non-OK HTTP or `success !== true`) THROWS — the caller must not treat that as
 * "fresh" and PATCH a minimal config, which would clobber an existing
 * observability block we simply couldn't read.
 */
export async function getScriptObservability(input: {
  accountId: string;
  script: string;
  accessToken: string;
  fetchImpl?: FetchImpl;
}): Promise<WorkerObservability | null> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const res = await fetchImpl(
    `${CLOUDFLARE_API_BASE}/accounts/${input.accountId}/workers/scripts/${encodeURIComponent(
      input.script,
    )}/settings`,
    { headers: { authorization: `Bearer ${input.accessToken}` } },
  );
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !json || json.success !== true) {
    throw new Error(`cloudflare: read worker settings failed (status ${res.status})`);
  }
  const result = json.result as Record<string, unknown> | undefined;
  const obs = result?.observability;
  return obs && typeof obs === "object" ? (obs as WorkerObservability) : null;
}

/**
 * PATCH a Worker's settings to set its `observability` config. The settings
 * endpoint only accepts `multipart/form-data` with a JSON `settings` part (not a
 * JSON body), so we build a FormData and let fetch set the multipart boundary.
 */
export async function updateScriptObservability(input: {
  accountId: string;
  script: string;
  observability: WorkerObservability;
  accessToken: string;
  fetchImpl?: FetchImpl;
}): Promise<{ ok: boolean; error?: string }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const form = new FormData();
  form.append(
    "settings",
    new Blob([JSON.stringify({ observability: input.observability })], {
      type: "application/json",
    }),
    "settings.json",
  );
  try {
    const res = await fetchImpl(
      `${CLOUDFLARE_API_BASE}/accounts/${input.accountId}/workers/scripts/${encodeURIComponent(
        input.script,
      )}/settings`,
      {
        method: "PATCH",
        headers: { authorization: `Bearer ${input.accessToken}` },
        body: form,
      },
    );
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (json?.success === true) return { ok: true };
    return { ok: false, error: extractCreateError(json ?? {}) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "request_failed" };
  }
}
