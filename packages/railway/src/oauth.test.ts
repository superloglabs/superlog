import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  RAILWAY_OAUTH_AUTH_URL,
  RAILWAY_OAUTH_SCOPES,
  RAILWAY_OAUTH_TOKEN_URL,
  buildAuthorizeUrl,
  decodeIdTokenSub,
  exchangeCodeForToken,
  parseTokenResponse,
  railwayConfigFromEnv,
  refreshAccessToken,
} from "./oauth.js";

test("railwayConfigFromEnv returns null until client id + secret are set", () => {
  assert.equal(railwayConfigFromEnv({}), null);
  assert.equal(railwayConfigFromEnv({ RAILWAY_CLIENT_ID: "id" }), null);
  const cfg = railwayConfigFromEnv({
    RAILWAY_CLIENT_ID: "id",
    RAILWAY_CLIENT_SECRET: "secret",
  });
  assert.ok(cfg);
  assert.equal(cfg.clientId, "id");
  assert.equal(cfg.redirectUri, "http://localhost:4100/railway/oauth/callback");
  const custom = railwayConfigFromEnv({
    RAILWAY_CLIENT_ID: "id",
    RAILWAY_CLIENT_SECRET: "secret",
    RAILWAY_OAUTH_REDIRECT_URL: "https://api.example.com/railway/oauth/callback",
  });
  assert.equal(custom?.redirectUri, "https://api.example.com/railway/oauth/callback");
});

test("buildAuthorizeUrl requests resource scopes and forces the consent screen", () => {
  const url = new URL(
    buildAuthorizeUrl({
      clientId: "cid",
      redirectUri: "https://api.example.com/railway/oauth/callback",
      state: "signed-state",
    }),
  );
  assert.equal(`${url.origin}${url.pathname}`, RAILWAY_OAUTH_AUTH_URL);
  assert.equal(url.searchParams.get("client_id"), "cid");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("state"), "signed-state");
  assert.equal(url.searchParams.get("scope"), RAILWAY_OAUTH_SCOPES);
  // Railway silently drops `offline_access` (no refresh token!) unless the
  // consent screen is forced.
  assert.equal(url.searchParams.get("prompt"), "consent");
  // The grant must include the project picker scope, and offline_access so the
  // puller can refresh past the 1h access-token expiry.
  assert.ok(RAILWAY_OAUTH_SCOPES.includes("project:viewer"));
  assert.ok(RAILWAY_OAUTH_SCOPES.includes("offline_access"));
});

test("parseTokenResponse extracts tokens, expiry and scope", () => {
  const parsed = parseTokenResponse({
    access_token: "at",
    refresh_token: "rt",
    expires_in: 3600,
    scope: "openid email profile offline_access project:viewer",
    token_type: "Bearer",
  });
  assert.ok(parsed.ok);
  assert.equal(parsed.accessToken, "at");
  assert.equal(parsed.refreshToken, "rt");
  assert.equal(parsed.expiresInSeconds, 3600);
  assert.ok(parsed.scope?.includes("project:viewer"));
});

test("parseTokenResponse tolerates a missing refresh token but not a missing access token", () => {
  const noRefresh = parseTokenResponse({ access_token: "at", expires_in: 3600 });
  assert.ok(noRefresh.ok);
  assert.equal(noRefresh.refreshToken, null);

  const bad = parseTokenResponse({ error: "invalid_grant" });
  assert.ok(!bad.ok);
  assert.equal(bad.error, "invalid_grant");
  assert.ok(!parseTokenResponse(null).ok);
  assert.ok(!parseTokenResponse({}).ok);
});

test("decodeIdTokenSub reads the sub claim without verifying (direct-channel response)", () => {
  const claims = Buffer.from(JSON.stringify({ sub: "user-123" }), "utf8").toString("base64url");
  assert.equal(decodeIdTokenSub(`header.${claims}.sig`), "user-123");
  assert.equal(decodeIdTokenSub("garbage"), null);
  assert.equal(decodeIdTokenSub(undefined), null);
});

test("exchangeCodeForToken posts the code with client credentials", async () => {
  const captured = { url: "", body: new URLSearchParams() };
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    captured.url = String(url);
    captured.body = new URLSearchParams(String(init?.body));
    return new Response(
      JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }),
      { status: 200 },
    );
  }) as typeof fetch;

  const result = await exchangeCodeForToken({
    config: { clientId: "cid", clientSecret: "cs", redirectUri: "https://r" },
    code: "the-code",
    fetchImpl,
  });
  assert.ok(result.ok);
  assert.equal(captured.url, RAILWAY_OAUTH_TOKEN_URL);
  assert.equal(captured.body.get("grant_type"), "authorization_code");
  assert.equal(captured.body.get("code"), "the-code");
  assert.equal(captured.body.get("client_id"), "cid");
  assert.equal(captured.body.get("client_secret"), "cs");
  assert.equal(captured.body.get("redirect_uri"), "https://r");
});

test("refreshAccessToken posts the rotating refresh token", async () => {
  let captured = new URLSearchParams();
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    captured = new URLSearchParams(String(init?.body));
    return new Response(
      JSON.stringify({ access_token: "at2", refresh_token: "rt2", expires_in: 3600 }),
      { status: 200 },
    );
  }) as typeof fetch;

  const result = await refreshAccessToken({
    config: { clientId: "cid", clientSecret: "cs", redirectUri: "https://r" },
    refreshToken: "rt1",
    fetchImpl,
  });
  assert.ok(result.ok);
  assert.equal(result.accessToken, "at2");
  // Rotation: the new refresh token replaces the old one and must be persisted.
  assert.equal(result.refreshToken, "rt2");
  assert.equal(captured.get("grant_type"), "refresh_token");
  assert.equal(captured.get("refresh_token"), "rt1");
});

test("exchangeCodeForToken reports non-OK statuses even with an unparseable body", async () => {
  const fetchImpl = (async () => new Response("nope", { status: 500 })) as typeof fetch;
  const result = await exchangeCodeForToken({
    config: { clientId: "cid", clientSecret: "cs", redirectUri: "https://r" },
    code: "c",
    fetchImpl,
  });
  assert.ok(!result.ok);
});
