// Cloudflare OAuth 2.0 client helpers, shared by the api (connect flow) and the
// worker (background token refresh). Cloudflare shipped self-managed OAuth for
// all developers in 2026-06; the connector uses it for a Slack-style "Connect
// Cloudflare" button.
//
// OAuth endpoints (from Cloudflare's "Integrate your OAuth client" docs):
//   authorize: https://dash.cloudflare.com/oauth2/auth
//   token:     https://dash.cloudflare.com/oauth2/token
//   revoke:    https://dash.cloudflare.com/oauth2/revoke
//
// Token model: access tokens are short-lived (hours); whether a refresh token
// is issued at all is controlled by the OAuth *client registration* — Cloudflare
// adds/removes `offline_access` automatically based on the client's grant
// types, and the client's "grant session duration" bounds how long the refresh
// token stays valid. Refresh tokens may rotate on use, so callers must persist
// the replacement immediately when one is returned.
//
// This module is deliberately IO-light (pure functions + injectable fetch),
// mirroring @superlog/railway.

export const CLOUDFLARE_OAUTH_AUTHORIZE_URL = "https://dash.cloudflare.com/oauth2/auth";
export const CLOUDFLARE_OAUTH_TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";
export const CLOUDFLARE_OAUTH_REVOKE_URL = "https://dash.cloudflare.com/oauth2/revoke";

export type FetchImpl = typeof fetch;

export type CloudflareOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

/** Just the client credentials — all the background keep-alive refresh needs
 * (the refresh grant sends no redirect_uri). */
export type CloudflareClientCredentials = Pick<CloudflareOAuthConfig, "clientId" | "clientSecret">;

/**
 * Read the OAuth client credentials from env; null (→ refresh disabled) when
 * either is missing. The worker's keep-alive job opts out when this is null —
 * without a client there's nothing to refresh with.
 */
export function cloudflareClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CloudflareClientCredentials | null {
  const clientId = env.CLOUDFLARE_CLIENT_ID;
  const clientSecret = env.CLOUDFLARE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

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

async function postTokenRequest(
  body: URLSearchParams,
  fetchImpl: FetchImpl,
): Promise<CloudflareTokenResult> {
  const res = await fetchImpl(CLOUDFLARE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json().catch(() => null);
  const parsed = parseTokenResponse(json);
  // A non-OK status with a parseable body still must not read as success.
  if (!res.ok && parsed.ok) return { ok: false, error: `status_${res.status}` };
  return parsed;
}

export async function exchangeCodeForToken(input: {
  config: CloudflareOAuthConfig;
  code: string;
  fetchImpl?: FetchImpl;
}): Promise<CloudflareTokenResult> {
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
  config: Pick<CloudflareOAuthConfig, "clientId" | "clientSecret">;
  refreshToken: string;
  fetchImpl?: FetchImpl;
}): Promise<CloudflareTokenResult> {
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
