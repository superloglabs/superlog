import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  CLOUDFLARE_OAUTH_TOKEN_URL,
  cloudflareClientFromEnv,
  exchangeCodeForToken,
  parseTokenResponse,
  refreshAccessToken,
} from "./oauth.js";

const CONFIG = {
  clientId: "cid",
  clientSecret: "csecret",
  redirectUri: "https://api.example.com/cloudflare/oauth/callback",
};

// Index into an array with narrowing (strict indexing forbids bare [0]).
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no element at index ${index}`);
  return item;
}

function fakeTokenFetch(response: { status?: number; json: unknown }) {
  const calls: { url: string; body: URLSearchParams }[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: new URLSearchParams(String(init?.body)),
    });
    return new Response(JSON.stringify(response.json), { status: response.status ?? 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

test("parseTokenResponse extracts tokens and surfaces errors", () => {
  const ok = parseTokenResponse({
    access_token: "at",
    refresh_token: "rt",
    expires_in: 57600,
    scope: "workers-scripts.read offline_access",
  });
  assert.deepEqual(ok, {
    ok: true,
    accessToken: "at",
    refreshToken: "rt",
    expiresIn: 57600,
    scope: "workers-scripts.read offline_access",
  });
  // An empty-string refresh token is treated as absent (null), not a valid token.
  const emptyRefresh = parseTokenResponse({ access_token: "at", refresh_token: "" });
  assert.ok(emptyRefresh.ok);
  assert.equal(emptyRefresh.refreshToken, null);
  assert.deepEqual(parseTokenResponse({ error: "invalid_grant" }), {
    ok: false,
    error: "invalid_grant",
  });
  assert.deepEqual(parseTokenResponse(null), { ok: false, error: "invalid_response" });
  assert.deepEqual(parseTokenResponse({}), { ok: false, error: "no_access_token" });
});

test("cloudflareClientFromEnv needs both id and secret, else null", () => {
  assert.equal(cloudflareClientFromEnv({}), null);
  assert.equal(cloudflareClientFromEnv({ CLOUDFLARE_CLIENT_ID: "cid" }), null);
  assert.equal(cloudflareClientFromEnv({ CLOUDFLARE_CLIENT_SECRET: "cs" }), null);
  assert.deepEqual(
    cloudflareClientFromEnv({ CLOUDFLARE_CLIENT_ID: "cid", CLOUDFLARE_CLIENT_SECRET: "cs" }),
    { clientId: "cid", clientSecret: "cs" },
  );
});

test("exchangeCodeForToken posts the authorization code with client credentials", async () => {
  const { fetchImpl, calls } = fakeTokenFetch({
    json: { access_token: "at", refresh_token: "rt", expires_in: 3600 },
  });
  const result = await exchangeCodeForToken({ config: CONFIG, code: "the-code", fetchImpl });
  assert.ok(result.ok);
  assert.equal(result.accessToken, "at");
  assert.equal(at(calls, 0).url, CLOUDFLARE_OAUTH_TOKEN_URL);
  assert.equal(at(calls, 0).body.get("grant_type"), "authorization_code");
  assert.equal(at(calls, 0).body.get("code"), "the-code");
  assert.equal(at(calls, 0).body.get("redirect_uri"), CONFIG.redirectUri);
  assert.equal(at(calls, 0).body.get("client_id"), "cid");
  assert.equal(at(calls, 0).body.get("client_secret"), "csecret");
});

test("refreshAccessToken posts the refresh token grant with client credentials", async () => {
  const { fetchImpl, calls } = fakeTokenFetch({
    json: { access_token: "at2", refresh_token: "rt2", expires_in: 57600 },
  });
  const result = await refreshAccessToken({ config: CONFIG, refreshToken: "rt1", fetchImpl });
  assert.ok(result.ok);
  assert.equal(result.accessToken, "at2");
  assert.equal(result.refreshToken, "rt2");
  assert.equal(result.expiresIn, 57600);
  assert.equal(at(calls, 0).url, CLOUDFLARE_OAUTH_TOKEN_URL);
  assert.equal(at(calls, 0).body.get("grant_type"), "refresh_token");
  assert.equal(at(calls, 0).body.get("refresh_token"), "rt1");
  assert.equal(at(calls, 0).body.get("client_id"), "cid");
  assert.equal(at(calls, 0).body.get("client_secret"), "csecret");
  assert.equal(at(calls, 0).body.get("redirect_uri"), null);
});

test("refreshAccessToken tolerates a response with no rotated refresh token", async () => {
  const { fetchImpl } = fakeTokenFetch({ json: { access_token: "at2", expires_in: 57600 } });
  const result = await refreshAccessToken({ config: CONFIG, refreshToken: "rt1", fetchImpl });
  assert.ok(result.ok);
  assert.equal(result.refreshToken, null);
});

test("a non-OK token response never reads as success", async () => {
  // Even if a proxy/error page returns something that parses as a token, a
  // non-2xx status must fail — mirrors the Railway client's guard.
  const { fetchImpl } = fakeTokenFetch({ status: 502, json: { access_token: "at" } });
  const result = await refreshAccessToken({ config: CONFIG, refreshToken: "rt1", fetchImpl });
  assert.ok(!result.ok);
  assert.equal(result.error, "status_502");

  const denied = fakeTokenFetch({ status: 400, json: { error: "invalid_grant" } });
  const deniedResult = await refreshAccessToken({
    config: CONFIG,
    refreshToken: "rt1",
    fetchImpl: denied.fetchImpl,
  });
  assert.ok(!deniedResult.ok);
  assert.equal(deniedResult.error, "invalid_grant");
});
