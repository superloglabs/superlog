// Pure helpers + thin (injectable-fetch) HTTP wrappers for the Vercel
// integration. Vercel's connectable-account integrations are OAuth2 apps: the
// user installs our integration from the external-flow install page, Vercel
// redirects back with a single-use code, and we exchange it for a long-lived
// token scoped to that installation. We then use the token to create a Drain
// (`POST /v1/drains`) that streams the team's deployments' OTLP traces straight
// to our intake — no copy-paste API tokens.
//
// Signals: Vercel's Drains support OTLP delivery (`type: "otlphttp"`) for
// traces. Log drains deliver Vercel JSON/NDJSON, so we point them at our
// Vercel-specific intake adapter, which translates to OTLP logs before the
// normal ingest path stores them.
//
// Endpoints (from Vercel's integrations + drains REST docs):
//   install:  https://vercel.com/integrations/<slug>/new   (external flow)
//   token:    https://api.vercel.com/v2/oauth/access_token
//   drains:   https://api.vercel.com/v1/drains[?teamId=…]
//   config:   https://api.vercel.com/v1/integrations/configuration/<id>
//
// This module is deliberately IO-light: everything is a pure function or a
// wrapper that takes an injectable `fetch`, so the route layer (vercel.ts)
// stays thin and the logic is unit-testable without a live Vercel account.

export const VERCEL_API_BASE = "https://api.vercel.com";
export const VERCEL_OAUTH_TOKEN_URL = `${VERCEL_API_BASE}/v2/oauth/access_token`;
export const VERCEL_INSTALL_BASE = "https://vercel.com/integrations";

export type { OAuthStatePayload as VercelStatePayload } from "./oauth-state.js";
export { signState, verifyState } from "./oauth-state.js";

export type VercelSignal = "traces" | "logs";

// signal → { Drain schema entry, our public intake path }.
export const VERCEL_DRAIN_SIGNALS: Record<
  VercelSignal,
  { schema: string; version: string; path: string }
> = {
  traces: { schema: "trace", version: "v1", path: "/vercel/drains/traces" },
  logs: { schema: "log", version: "v1", path: "/vercel/drains/logs" },
};

export const VERCEL_SIGNALS: VercelSignal[] = ["traces", "logs"];

export type VercelConnectErrorOutcome =
  | "error"
  | "drains_unavailable";

export class VercelProvisioningError extends Error {
  constructor(
    message: string,
    readonly outcome: VercelConnectErrorOutcome,
  ) {
    super(message);
  }
}

export function classifyDrainProvisioningFailure(errors: string[]): VercelConnectErrorOutcome {
  if (errors.some((error) => /drains are not available/i.test(error))) {
    return "drains_unavailable";
  }
  return "error";
}

/**
 * Web path the OAuth callback redirects to. Always the dedicated result page —
 * the callback usually lands in a fresh tab (the install opens via
 * window.open), so redirecting to `/` with a query param renders whatever `/`
 * shows and the outcome goes unseen unless the onboarding wizard happens to be
 * mounted there.
 */
export function connectResultPath(outcome: string): string {
  return `/connect/vercel?vercel=${encodeURIComponent(outcome)}`;
}

export type VercelConnectConfig = {
  clientId: string;
  clientSecret: string;
  /** Marketplace slug of our integration — forms the install URL. */
  integrationSlug: string;
  redirectUri: string;
  /**
   * Base URL of our public OTLP intake (trailing slash stripped), e.g.
   * `https://intake.superlog.sh`. Created drains target the Vercel-specific
   * adapter paths under `${intakeBaseUrl}/vercel/drains/*`.
   */
  intakeBaseUrl: string;
};

/** Read connector config from env; null (→ feature disabled) when unconfigured. */
export function vercelConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): VercelConnectConfig | null {
  const clientId = env.VERCEL_CLIENT_ID;
  const clientSecret = env.VERCEL_CLIENT_SECRET;
  const integrationSlug = env.VERCEL_INTEGRATION_SLUG;
  const intake = env.VERCEL_OTLP_INTAKE_URL;
  if (!clientId || !clientSecret || !integrationSlug || !intake) return null;
  const redirectUri =
    env.VERCEL_OAUTH_REDIRECT_URL ?? "http://localhost:4100/vercel/oauth/callback";
  return {
    clientId,
    clientSecret,
    integrationSlug,
    redirectUri,
    intakeBaseUrl: intake.replace(/\/+$/, ""),
  };
}

/**
 * The external-flow install page for our integration. Vercel echoes `state`
 * back to the redirect URL (which is registered on the integration itself, so
 * it isn't a parameter here).
 */
export function buildInstallUrl(input: { integrationSlug: string; state: string }): string {
  const url = new URL(`${VERCEL_INSTALL_BASE}/${input.integrationSlug}/new`);
  url.searchParams.set("state", input.state);
  return url.toString();
}

/**
 * A drain name identifies the Superlog project on the customer's team, so a
 * second project connecting the same team gets its own drain instead of an
 * ambiguous duplicate. Same short project token scheme as the Cloudflare
 * connector's destination names.
 */
export function projectDrainToken(projectId: string): string {
  return projectId
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 12)
    .toLowerCase();
}

export function drainName(projectId: string, signal: VercelSignal): string {
  return `superlog-${projectDrainToken(projectId)}-${signal}`;
}

export function intakeUrlForSignal(base: string, signal: VercelSignal): string {
  return `${base.replace(/\/+$/, "")}${VERCEL_DRAIN_SIGNALS[signal].path}`;
}

export type DrainPayload = {
  name: string;
  // "all": every project on the team streams in — per-project scoping happens
  // on our side via the ingest key → Superlog project mapping (mirrors how the
  // Cloudflare connector wires every Worker on the account).
  projects: "all";
  schemas: Record<string, { version: string }>;
  delivery:
    | {
        type: "otlphttp";
        endpoint: Record<string, string>;
        encoding: "proto";
        headers: Record<string, string>;
      }
    | {
        type: "http";
        endpoint: string;
        encoding: "json";
        headers: Record<string, string>;
      };
};

/**
 * Build the Drain payload for one signal: an OTLP/HTTP delivery pointed at our
 * intake and authenticated with the project's ingest key via `x-api-key`.
 */
export function buildDrainPayload(input: {
  signal: VercelSignal;
  intakeBaseUrl: string;
  ingestKey: string;
  projectId: string;
}): DrainPayload {
  const sig = VERCEL_DRAIN_SIGNALS[input.signal];
  const endpoint = intakeUrlForSignal(input.intakeBaseUrl, input.signal);
  return {
    name: drainName(input.projectId, input.signal),
    projects: "all",
    schemas: { [sig.schema]: { version: sig.version } },
    delivery:
      input.signal === "traces"
        ? {
            type: "otlphttp",
            endpoint: { traces: endpoint },
            encoding: "proto",
            headers: { "x-api-key": input.ingestKey },
          }
        : {
            type: "http",
            endpoint,
            encoding: "json",
            headers: { "x-api-key": input.ingestKey },
          },
  };
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/** Vercel's standard error envelope is `{ error: { code, message } }`. */
function extractError(o: Record<string, unknown>): string | null {
  const err = o.error;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (typeof e.message === "string") return e.message;
    if (typeof e.code === "string") return e.code;
    return "request_failed";
  }
  return null;
}

export type VercelTokenResult =
  | {
      ok: true;
      accessToken: string;
      /** The integration configuration this token belongs to (`icfg_…`). */
      installationId: string;
      userId: string | null;
      /** Null for personal-account installs; required as `?teamId=` otherwise. */
      teamId: string | null;
    }
  | { ok: false; error: string };

export function parseTokenResponse(json: unknown): VercelTokenResult {
  if (!json || typeof json !== "object") return { ok: false, error: "invalid_response" };
  const o = json as Record<string, unknown>;
  const error = extractError(o);
  if (error) return { ok: false, error };
  if (typeof o.access_token !== "string" || !o.access_token) {
    return { ok: false, error: "no_access_token" };
  }
  // Without the installation id we can't tie the token to a configuration (or
  // tear the install down later) — refuse rather than persist an unmanageable
  // grant.
  if (typeof o.installation_id !== "string" || !o.installation_id) {
    return { ok: false, error: "no_installation_id" };
  }
  return {
    ok: true,
    accessToken: o.access_token,
    installationId: o.installation_id,
    userId: typeof o.user_id === "string" ? o.user_id : null,
    teamId: typeof o.team_id === "string" && o.team_id ? o.team_id : null,
  };
}

export type CreateDrainResult = { ok: true; id: string } | { ok: false; error: string };

export function parseCreateDrainResponse(json: unknown): CreateDrainResult {
  if (!json || typeof json !== "object") return { ok: false, error: "invalid_response" };
  const o = json as Record<string, unknown>;
  const error = extractError(o);
  if (error) return { ok: false, error };
  // A drain we can't identify can't be deleted on reconnect/uninstall — treat a
  // response without an id as a failure rather than persist an unmanageable one.
  if (typeof o.id !== "string" || !o.id) return { ok: false, error: "no_drain_id" };
  return { ok: true, id: o.id };
}

// ---------------------------------------------------------------------------
// HTTP wrappers (injectable fetch)
// ---------------------------------------------------------------------------

export type FetchImpl = typeof fetch;

/** `?teamId=…` suffix for team installs; empty for personal-account installs. */
function teamQuery(teamId: string | null): string {
  return teamId ? `?teamId=${encodeURIComponent(teamId)}` : "";
}

export async function exchangeCodeForToken(input: {
  config: VercelConnectConfig;
  code: string;
  fetchImpl?: FetchImpl;
}): Promise<VercelTokenResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const res = await fetchImpl(VERCEL_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: input.config.clientId,
      client_secret: input.config.clientSecret,
      code: input.code,
      redirect_uri: input.config.redirectUri,
    }),
  });
  const json = await res.json().catch(() => null);
  return parseTokenResponse(json);
}

export async function createDrain(input: {
  teamId: string | null;
  accessToken: string;
  payload: DrainPayload;
  fetchImpl?: FetchImpl;
}): Promise<CreateDrainResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const res = await fetchImpl(`${VERCEL_API_BASE}/v1/drains${teamQuery(input.teamId)}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${input.accessToken}`,
    },
    body: JSON.stringify(input.payload),
  });
  const json = await res.json().catch(() => null);
  const parsed = parseCreateDrainResponse(json);
  // A non-OK status with an unparseable body still must not read as success.
  if (!res.ok && parsed.ok) return { ok: false, error: `status_${res.status}` };
  return parsed;
}

/**
 * Delete a Drain by id. Best-effort (used when superseding a prior connect so
 * we don't leave duplicate drains streaming): never throws, returns whether
 * Vercel accepted the delete.
 */
export async function deleteDrain(input: {
  teamId: string | null;
  accessToken: string;
  drainId: string;
  fetchImpl?: FetchImpl;
}): Promise<{ ok: boolean }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(
      `${VERCEL_API_BASE}/v1/drains/${encodeURIComponent(input.drainId)}${teamQuery(input.teamId)}`,
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

/**
 * Delete the integration configuration (the install itself) — Vercel's analog
 * of an OAuth token revoke: the token stops working and the install disappears
 * from the user's team. Best-effort, never throws.
 */
export async function deleteConfiguration(input: {
  teamId: string | null;
  accessToken: string;
  configurationId: string;
  fetchImpl?: FetchImpl;
}): Promise<{ ok: boolean }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(
      `${VERCEL_API_BASE}/v1/integrations/configuration/${encodeURIComponent(
        input.configurationId,
      )}${teamQuery(input.teamId)}`,
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

/**
 * Resolve the team's display name for the connected chip in the UI. Purely
 * cosmetic, so any failure (including personal installs, which have no team)
 * resolves to null rather than throwing.
 */
export async function fetchTeamName(input: {
  teamId: string | null;
  accessToken: string;
  fetchImpl?: FetchImpl;
}): Promise<string | null> {
  if (!input.teamId) return null;
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(
      `${VERCEL_API_BASE}/v2/teams/${encodeURIComponent(input.teamId)}`,
      { headers: { authorization: `Bearer ${input.accessToken}` } },
    );
    if (!res.ok) return null;
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!json) return null;
    if (typeof json.name === "string" && json.name) return json.name;
    if (typeof json.slug === "string" && json.slug) return json.slug;
    return null;
  } catch {
    return null;
  }
}

/**
 * Given the prior same-configuration drains and the ones we just (re)created,
 * return the prior drain ids that are now stale and should be deleted remotely.
 * Same guards as the Cloudflare connector: only signals that actually got a
 * fresh drain this run are eligible, and an id that's still live is kept.
 */
export function staleDrainIds(
  previous: Record<string, string> | null | undefined,
  current: Record<string, string>,
): Record<string, string> {
  if (!previous) return {};
  const liveIds = new Set(Object.values(current));
  return Object.fromEntries(
    Object.entries(previous).filter(([signal, id]) => signal in current && !liveIds.has(id)),
  );
}
