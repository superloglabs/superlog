// Pure helpers + thin (injectable-fetch) HTTP wrappers for the Cloudflare
// integration. Cloudflare shipped self-managed OAuth for all developers in
// 2026-06, so we can offer a Slack-style "Connect Cloudflare" button: the user
// consents, and we use the granted token to create Workers Observability
// "telemetry destinations" that export OTLP traces/logs straight to our
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

export const CLOUDFLARE_OAUTH_AUTHORIZE_URL = "https://dash.cloudflare.com/oauth2/auth";
export const CLOUDFLARE_OAUTH_TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";
export const CLOUDFLARE_OAUTH_REVOKE_URL = "https://dash.cloudflare.com/oauth2/revoke";

// Cloudflare OAuth scope identifiers (dot-delimited, mirroring API-token
// permission names — verified against `GET /client/v4/oauth/scopes`). The
// connector needs to:
//   - account-settings.read            list the account (resolve the account id)
//   - workers-observability(.write)    create the telemetry destinations
//   - workers-observability-telemetry.write   (destinations live under this perm)
//   - workers-scripts.read/.write      read each Worker's observability config
//                                      and wire our destinations into it
//   - offline_access                   the offline grant — makes Cloudflare
//                                      issue a long-lived refresh token so the
//                                      short-lived access token can be renewed
//                                      on demand instead of dying for good
//                                      (~16h after connect). The refresh token's
//                                      lifetime is bounded by the OAuth client
//                                      registration's "grant session duration"
//                                      (set it long, e.g. a year); the client
//                                      must also permit the refresh_token grant.
// Override with CLOUDFLARE_OAUTH_SCOPES if a deployment's client differs.
export const DEFAULT_CLOUDFLARE_OAUTH_SCOPES = [
  "account-settings.read",
  "workers-observability.write",
  "workers-observability-telemetry.write",
  "workers-scripts.read",
  "workers-scripts.write",
  "offline_access",
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

// Signals we actually provision a destination for. Metrics is intentionally
// excluded: Workers Observability exports only traces and logs over OTLP —
// metrics export "is not yet supported" (no `observability.metrics` config key,
// and the create API rejects an `opentelemetry-metrics` destination with a
// Bad Request). The `metrics` mapping above is kept so this is a one-line
// re-enable once Cloudflare ships metrics export.
export const CLOUDFLARE_SIGNALS: CloudflareSignal[] = ["traces", "logs"];

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
 * A destination name is per Cloudflare *account*, so it must also identify the
 * Superlog project — otherwise a second project connecting the same account
 * upserts-by-name over the first project's destination (hijacking its ingest
 * key) and the two projects become mutually exclusive. We derive a short,
 * regex-safe token from the project id so each project gets its own destination
 * (`superlog-<token>-<signal>`) and a Worker can fan out to several projects.
 */
export function projectDestinationToken(projectId: string): string {
  return projectId
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 12)
    .toLowerCase();
}

export function destinationName(projectId: string, signal: CloudflareSignal): string {
  return `superlog-${projectDestinationToken(projectId)}-${signal}`;
}

/**
 * Build the Workers Observability destination payload for one signal: a Logpush
 * destination with the matching `opentelemetry-*` dataset, pointed at our intake
 * and authenticated with the project's ingest key via `x-api-key`.
 *
 * The destination `name` is `superlog-<projectToken>-<signal>` — project-scoped
 * (see destinationName) and matching Cloudflare's `^[a-z0-9-]+$` rule.
 */
export function buildDestinationPayload(input: {
  signal: CloudflareSignal;
  intakeBaseUrl: string;
  ingestKey: string;
  projectId: string;
}): DestinationPayload {
  const sig = CLOUDFLARE_OTLP_SIGNALS[input.signal];
  return {
    name: destinationName(input.projectId, input.signal),
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
// OAuth state (signed, short-lived) — the shared connector scheme lives in
// oauth-state.ts; re-exported here so existing imports keep working.
// ---------------------------------------------------------------------------

export type { OAuthStatePayload as CloudflareStatePayload } from "./oauth-state.js";
export { signState, verifyState } from "./oauth-state.js";

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

// OAuth token primitives (exchange / refresh / parse) and the Workers
// Observability wiring + script client live in @superlog/cloudflare so the
// worker's background jobs (token refresh, wiring reconcile) share exactly one
// implementation with this connect flow. Re-exported here so existing api
// imports keep working.
export {
  CLOUDFLARE_API_BASE,
  type CloudflareTokenResult,
  type WorkerDestinationSlugs,
  type WorkerObservability,
  type WorkerObservabilitySignal,
  exchangeCodeForToken,
  getScriptObservability,
  isWorkerWired,
  listScripts,
  listScriptsStrict,
  parseScriptsResponse,
  parseTokenResponse,
  reconcileWorkerWiring,
  refreshAccessToken,
  unwireObservabilityDestinations,
  updateScriptObservability,
  wireObservabilityDestinations,
} from "@superlog/cloudflare";

// Imported (not just re-exported) because the account/destination wrappers below
// still build request URLs against it.
import { CLOUDFLARE_API_BASE } from "@superlog/cloudflare";

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
 *  - A prior slug that's still present in the new set is kept (reconnect updates
 *    same-account destinations in place, so that slug is still live).
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
// HTTP wrappers (injectable fetch)
//
// The Workers Observability wiring (wire/unwire/isWorkerWired) and script client
// (listScripts/getScriptObservability/updateScriptObservability/reconcile) moved
// to @superlog/cloudflare so the worker's reconcile job shares them; they're
// re-exported above. Only the account + destination wrappers, which are connect-
// only, stay here.
// ---------------------------------------------------------------------------

export type FetchImpl = typeof fetch;

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
 * Ensure one project-owned destination is configured for the latest connection.
 * Reconnects PATCH the slug already persisted for the same Cloudflare account:
 * destination names are unique and Cloudflare's create endpoint does not upsert.
 */
export async function ensureDestination(input: {
  accountId: string;
  accessToken: string;
  existingSlug?: string;
  payload: DestinationPayload;
  fetchImpl?: FetchImpl;
}): Promise<CreateDestinationResult> {
  if (!input.existingSlug) return createDestination(input);

  const fetchImpl = input.fetchImpl ?? fetch;
  const res = await fetchImpl(
    `${CLOUDFLARE_API_BASE}/accounts/${input.accountId}/workers/observability/destinations/${encodeURIComponent(
      input.existingSlug,
    )}`,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.accessToken}`,
      },
      body: JSON.stringify({
        enabled: input.payload.enabled,
        configuration: {
          type: input.payload.configuration.type,
          url: input.payload.configuration.url,
          headers: input.payload.configuration.headers,
        },
      }),
    },
  );
  const json = await res.json().catch(() => null);
  if (res.status === 404) return createDestination(input);
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
