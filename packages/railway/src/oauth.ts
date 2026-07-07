// "Login with Railway" OAuth 2.0 client. Railway has no drain/export product,
// so unlike the Vercel connector nothing is provisioned on Railway's side at
// connect time: the OAuth grant itself *is* the integration — a `project:viewer`
// token the worker-side puller uses to read logs and metrics from the granted
// projects via the GraphQL API.
//
// Endpoints (from Railway's OAuth docs):
//   authorize: https://backboard.railway.com/oauth/auth
//   token:     https://backboard.railway.com/oauth/token
//
// Token model: access tokens expire after ~1h; refresh tokens rotate on every
// use (persist the replacement immediately) and live ~1 year. Two consent
// gotchas discovered empirically: unknown scopes are dropped *silently*, and
// `offline_access` is only honored when `prompt=consent` forces the consent
// screen — without it the response simply has no refresh token.
//
// This module is deliberately IO-light (pure functions + injectable fetch),
// mirroring the Vercel/Cloudflare connector services.

export const RAILWAY_OAUTH_AUTH_URL = "https://backboard.railway.com/oauth/auth";
export const RAILWAY_OAUTH_TOKEN_URL = "https://backboard.railway.com/oauth/token";

// `project:viewer` puts a project picker on the consent screen and grants
// read access to exactly the projects the user selects — logs and metrics
// included. `offline_access` gets the refresh token the puller lives on.
export const RAILWAY_OAUTH_SCOPES = "openid email profile offline_access project:viewer";

export type FetchImpl = typeof fetch;

export type RailwayOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

/** Read connector config from env; null (→ feature disabled) when unconfigured. */
export function railwayConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RailwayOAuthConfig | null {
  const clientId = env.RAILWAY_CLIENT_ID;
  const clientSecret = env.RAILWAY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    redirectUri:
      env.RAILWAY_OAUTH_REDIRECT_URL ?? "http://localhost:4100/railway/oauth/callback",
  };
}

export function buildAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(RAILWAY_OAUTH_AUTH_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", RAILWAY_OAUTH_SCOPES);
  // Force the consent screen: it's where the user picks projects, and Railway
  // only issues a refresh token when consent is (re-)prompted.
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", input.state);
  return url.toString();
}

export type RailwayTokenResult =
  | {
      ok: true;
      accessToken: string;
      /** Null when the grant lacked offline_access — the install then degrades at expiry. */
      refreshToken: string | null;
      expiresInSeconds: number | null;
      scope: string | null;
      /** OIDC id_token, when present — carries the user's `sub`. */
      idToken: string | null;
    }
  | { ok: false; error: string };

export function parseTokenResponse(json: unknown): RailwayTokenResult {
  if (!json || typeof json !== "object") return { ok: false, error: "invalid_response" };
  const o = json as Record<string, unknown>;
  if (typeof o.error === "string") return { ok: false, error: o.error };
  if (typeof o.access_token !== "string" || !o.access_token) {
    return { ok: false, error: "no_access_token" };
  }
  return {
    ok: true,
    accessToken: o.access_token,
    refreshToken: typeof o.refresh_token === "string" && o.refresh_token ? o.refresh_token : null,
    expiresInSeconds:
      typeof o.expires_in === "number" && Number.isFinite(o.expires_in) ? o.expires_in : null,
    scope: typeof o.scope === "string" ? o.scope : null,
    idToken: typeof o.id_token === "string" && o.id_token ? o.id_token : null,
  };
}

/**
 * Read the `sub` claim out of an id_token without signature verification —
 * acceptable here because the token arrives over the direct TLS channel from
 * Railway's token endpoint, not from the browser.
 */
export function decodeIdTokenSub(idToken: string | null | undefined): string | null {
  if (!idToken) return null;
  const payload = idToken.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    return typeof claims.sub === "string" && claims.sub ? claims.sub : null;
  } catch {
    return null;
  }
}

async function postTokenRequest(
  body: URLSearchParams,
  fetchImpl: FetchImpl,
): Promise<RailwayTokenResult> {
  const res = await fetchImpl(RAILWAY_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json().catch(() => null);
  const parsed = parseTokenResponse(json);
  // A non-OK status with an unparseable body still must not read as success.
  if (!res.ok && parsed.ok) return { ok: false, error: `status_${res.status}` };
  return parsed;
}

export async function exchangeCodeForToken(input: {
  config: RailwayOAuthConfig;
  code: string;
  fetchImpl?: FetchImpl;
}): Promise<RailwayTokenResult> {
  return postTokenRequest(
    new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.config.redirectUri,
      client_id: input.config.clientId,
      client_secret: input.config.clientSecret,
    }),
    input.fetchImpl ?? fetch,
  );
}

export async function refreshAccessToken(input: {
  config: RailwayOAuthConfig;
  refreshToken: string;
  fetchImpl?: FetchImpl;
}): Promise<RailwayTokenResult> {
  return postTokenRequest(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      client_id: input.config.clientId,
      client_secret: input.config.clientSecret,
    }),
    input.fetchImpl ?? fetch,
  );
}
