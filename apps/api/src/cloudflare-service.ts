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

// Cloudflare OAuth scope identifiers mirror API-token permission names
// (dot-delimited). These defaults cover what the connector needs: read the
// account list (to resolve the account id the destination APIs are scoped to)
// and manage Workers Observability telemetry destinations. They're best-effort —
// confirm the exact identifiers via `GET /client/v4/oauth/scopes` when
// registering the client and override with CLOUDFLARE_OAUTH_SCOPES if they
// differ. `offline_access` is added/removed automatically by Cloudflare based on
// the client's grant types, so we don't list it here.
export const DEFAULT_CLOUDFLARE_OAUTH_SCOPES = [
  "account.read",
  "workers-observability.read",
  "workers-observability.write",
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
 */
export function buildDestinationPayload(input: {
  signal: CloudflareSignal;
  intakeBaseUrl: string;
  ingestKey: string;
}): DestinationPayload {
  const sig = CLOUDFLARE_OTLP_SIGNALS[input.signal];
  return {
    name: `Superlog ${input.signal}`,
    enabled: true,
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

/** Parse the create-destination response → `{ success, result: { slug } }`. */
export function parseCreateDestinationResponse(json: unknown): CreateDestinationResult {
  if (!json || typeof json !== "object") return { ok: false, error: "invalid_response" };
  const o = json as Record<string, unknown>;
  if (o.success === false) {
    const errors = Array.isArray(o.errors) ? o.errors : [];
    const first = errors[0] as Record<string, unknown> | undefined;
    const msg = first && typeof first.message === "string" ? first.message : "request_failed";
    return { ok: false, error: msg };
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
