import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  CLOUDFLARE_OAUTH_AUTHORIZE_URL,
  buildAuthorizeUrl,
  buildDestinationPayload,
  cloudflareConfigFromEnv,
  createDestination,
  deleteDestination,
  exchangeCodeForToken,
  intakeUrlForSignal,
  listAccounts,
  parseAccountsResponse,
  parseCreateDestinationResponse,
  parseScriptsResponse,
  parseTokenResponse,
  signState,
  staleDestinationSlugs,
  verifyState,
  wireObservabilityDestinations,
} from "./cloudflare-service.js";

const SECRET = "test-state-secret";

test("cloudflareConfigFromEnv returns null until required vars are set", () => {
  assert.equal(cloudflareConfigFromEnv({}), null);
  assert.equal(cloudflareConfigFromEnv({ CLOUDFLARE_CLIENT_ID: "id" }), null);
  const cfg = cloudflareConfigFromEnv({
    CLOUDFLARE_CLIENT_ID: "id",
    CLOUDFLARE_CLIENT_SECRET: "secret",
    CLOUDFLARE_OTLP_INTAKE_URL: "https://intake.example.com/",
  });
  assert.ok(cfg);
  // trailing slash trimmed; sensible defaults applied
  assert.equal(cfg.intakeBaseUrl, "https://intake.example.com");
  assert.equal(cfg.redirectUri, "http://localhost:4100/cloudflare/oauth/callback");
  assert.deepEqual(cfg.scopes, [
    "account-settings.read",
    "workers-observability.write",
    "workers-observability-telemetry.write",
    "workers-scripts.read",
    "workers-scripts.write",
  ]);
});

test("cloudflareConfigFromEnv honours scope + redirect overrides", () => {
  const cfg = cloudflareConfigFromEnv({
    CLOUDFLARE_CLIENT_ID: "id",
    CLOUDFLARE_CLIENT_SECRET: "secret",
    CLOUDFLARE_OTLP_INTAKE_URL: "https://intake.example.com",
    CLOUDFLARE_OAUTH_SCOPES: "account.read  workers-observability.write",
    CLOUDFLARE_OAUTH_REDIRECT_URL: "https://api.example.com/cloudflare/oauth/callback",
  });
  assert.ok(cfg);
  assert.deepEqual(cfg.scopes, ["account.read", "workers-observability.write"]);
  assert.equal(cfg.redirectUri, "https://api.example.com/cloudflare/oauth/callback");
});

test("buildAuthorizeUrl targets Cloudflare's authorize endpoint with the right params", () => {
  const url = buildAuthorizeUrl({
    clientId: "client-123",
    redirectUri: "https://api.example.com/cloudflare/oauth/callback",
    scopes: ["account.read", "workers-observability.write"],
    state: "signed-state",
  });
  const u = new URL(url);
  assert.equal(`${u.origin}${u.pathname}`, CLOUDFLARE_OAUTH_AUTHORIZE_URL);
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("client_id"), "client-123");
  assert.equal(
    u.searchParams.get("redirect_uri"),
    "https://api.example.com/cloudflare/oauth/callback",
  );
  assert.equal(u.searchParams.get("scope"), "account.read workers-observability.write");
  assert.equal(u.searchParams.get("state"), "signed-state");
});

test("intakeUrlForSignal maps each signal to the OTLP path", () => {
  assert.equal(
    intakeUrlForSignal("https://intake.example.com", "traces"),
    "https://intake.example.com/v1/traces",
  );
  assert.equal(
    intakeUrlForSignal("https://intake.example.com/", "logs"),
    "https://intake.example.com/v1/logs",
  );
  assert.equal(
    intakeUrlForSignal("https://intake.example.com", "metrics"),
    "https://intake.example.com/v1/metrics",
  );
});

test("buildDestinationPayload builds a Logpush OTLP destination with the ingest key header", () => {
  const payload = buildDestinationPayload({
    signal: "logs",
    intakeBaseUrl: "https://intake.example.com",
    ingestKey: "sl_public_abc123",
  });
  assert.equal(payload.enabled, true);
  // Cloudflare requires the name to match ^[a-z0-9-]+$ — a display string like
  // "Superlog logs" is rejected with a ZodError.
  assert.equal(payload.name, "superlog-logs");
  assert.match(payload.name, /^[a-z0-9-]+$/);
  assert.equal(payload.skipPreflightCheck, true);
  assert.equal(payload.configuration.type, "logpush");
  assert.equal(payload.configuration.logpushDataset, "opentelemetry-logs");
  assert.equal(payload.configuration.url, "https://intake.example.com/v1/logs");
  assert.equal(payload.configuration.headers["x-api-key"], "sl_public_abc123");
});

test("signState/verifyState round-trips and rejects tampering + expiry", () => {
  const state = signState({ orgId: "org-1", projectId: "proj-1", userId: "user-1" }, SECRET);
  const decoded = verifyState(state, SECRET);
  assert.ok(decoded);
  assert.equal(decoded.orgId, "org-1");
  assert.equal(decoded.projectId, "proj-1");
  assert.equal(decoded.userId, "user-1");

  // wrong secret
  assert.equal(verifyState(state, "other-secret"), null);
  // tampered payload
  const [b64] = state.split(".");
  assert.equal(verifyState(`${b64}.deadbeef`, SECRET), null);
  // garbage
  assert.equal(verifyState("not-a-state", SECRET), null);
});

test("verifyState rejects state older than the 10-minute TTL", () => {
  const realNow = Date.now;
  try {
    Date.now = () => 1_000_000;
    const stale = signState({ orgId: "o", projectId: "p", userId: null }, SECRET);
    Date.now = () => 1_000_000 + 11 * 60 * 1000;
    assert.equal(verifyState(stale, SECRET), null);
  } finally {
    Date.now = realNow;
  }
});

test("parseTokenResponse extracts tokens and surfaces errors", () => {
  const ok = parseTokenResponse({
    access_token: "at",
    refresh_token: "rt",
    expires_in: 3600,
    scope: "account.read",
  });
  assert.deepEqual(ok, {
    ok: true,
    accessToken: "at",
    refreshToken: "rt",
    expiresIn: 3600,
    scope: "account.read",
  });
  assert.deepEqual(parseTokenResponse({ access_token: "at" }), {
    ok: true,
    accessToken: "at",
    refreshToken: null,
    expiresIn: null,
    scope: null,
  });
  assert.deepEqual(parseTokenResponse({ error: "invalid_grant" }), {
    ok: false,
    error: "invalid_grant",
  });
  assert.deepEqual(parseTokenResponse(null), { ok: false, error: "invalid_response" });
  assert.deepEqual(parseTokenResponse({}), { ok: false, error: "no_access_token" });
});

test("parseAccountsResponse pulls id/name pairs and ignores malformed rows", () => {
  const accounts = parseAccountsResponse({
    success: true,
    result: [{ id: "acct-1", name: "Acme" }, { id: "acct-2" }, { name: "no-id" }, "garbage"],
  });
  assert.deepEqual(accounts, [
    { id: "acct-1", name: "Acme" },
    { id: "acct-2", name: "" },
  ]);
  assert.deepEqual(parseAccountsResponse(null), []);
});

test("staleDestinationSlugs only deletes prior slugs for signals that got a replacement", () => {
  // No prior install → nothing to clean up.
  assert.deepEqual(staleDestinationSlugs(null, { traces: "new-1" }), {});

  // Every signal recreated with a new slug → all prior slugs are stale.
  assert.deepEqual(
    staleDestinationSlugs({ traces: "old-t", logs: "old-l" }, { traces: "new-t", logs: "new-l" }),
    { traces: "old-t", logs: "old-l" },
  );

  // `logs` failed to recreate (absent from current) → its prior slug is KEPT so
  // that signal keeps streaming; only the replaced `traces` slug is stale.
  assert.deepEqual(staleDestinationSlugs({ traces: "old-t", logs: "old-l" }, { traces: "new-t" }), {
    traces: "old-t",
  });

  // Cloudflare returned the same slug (upsert-by-name) → it's the live one, keep it.
  assert.deepEqual(staleDestinationSlugs({ traces: "same" }, { traces: "same" }), {});
});

test("parseScriptsResponse pulls script ids and ignores malformed rows", () => {
  assert.deepEqual(
    parseScriptsResponse({ result: [{ id: "worker-a" }, { id: "worker-b" }, {}, "x"] }),
    ["worker-a", "worker-b"],
  );
  assert.deepEqual(parseScriptsResponse(null), []);
});

test("wireObservabilityDestinations is additive + idempotent and skips when already wired", () => {
  // Fresh Worker (no observability) → enable everything, add both destinations.
  assert.deepEqual(
    wireObservabilityDestinations(null, { traces: "superlog-traces", logs: "superlog-logs" }),
    {
      enabled: true,
      logs: { enabled: true, destinations: ["superlog-logs"] },
      traces: { enabled: true, destinations: ["superlog-traces"] },
    },
  );

  // Existing config: keep other destinations + fields, append ours, enable traces.
  assert.deepEqual(
    wireObservabilityDestinations(
      {
        enabled: true,
        head_sampling_rate: 1,
        logs: { enabled: true, persist: true, destinations: ["other-dest"] },
        traces: { enabled: false, head_sampling_rate: 1 },
      },
      { traces: "superlog-traces", logs: "superlog-logs" },
    ),
    {
      enabled: true,
      head_sampling_rate: 1,
      logs: { enabled: true, persist: true, destinations: ["other-dest", "superlog-logs"] },
      traces: { enabled: true, head_sampling_rate: 1, destinations: ["superlog-traces"] },
    },
  );

  // Already wired → null (no PATCH needed).
  assert.equal(
    wireObservabilityDestinations(
      {
        enabled: true,
        logs: { enabled: true, destinations: ["superlog-logs"] },
        traces: { enabled: true, destinations: ["superlog-traces"] },
      },
      { traces: "superlog-traces", logs: "superlog-logs" },
    ),
    null,
  );

  // Only the signals we pass a slug for are touched.
  assert.deepEqual(wireObservabilityDestinations(null, { logs: "superlog-logs" }), {
    enabled: true,
    logs: { enabled: true, destinations: ["superlog-logs"] },
  });
});

test("parseCreateDestinationResponse returns slug on success and message on failure", () => {
  assert.deepEqual(parseCreateDestinationResponse({ success: true, result: { slug: "dest-1" } }), {
    ok: true,
    slug: "dest-1",
  });
  assert.deepEqual(parseCreateDestinationResponse({ success: true, result: {} }), {
    ok: true,
    slug: null,
  });
  assert.deepEqual(
    parseCreateDestinationResponse({ success: false, errors: [{ message: "nope" }] }),
    { ok: false, error: "nope" },
  );
  // Request-body validation failures come back as a ZodError, not the standard
  // envelope — surface the issue message instead of a generic "request_failed".
  assert.deepEqual(
    parseCreateDestinationResponse({
      success: false,
      error: {
        name: "ZodError",
        issues: [{ message: "The destination name must contain only lowercase letters…" }],
      },
    }),
    { ok: false, error: "The destination name must contain only lowercase letters…" },
  );
  // A malformed/partial response that omits `success` must NOT be accepted as a
  // provisioned destination — it's a failure, not a slug-less success.
  assert.deepEqual(parseCreateDestinationResponse({ result: { slug: "dest-1" } }), {
    ok: false,
    error: "request_failed",
  });
  assert.deepEqual(parseCreateDestinationResponse({}), {
    ok: false,
    error: "request_failed",
  });
});

test("exchangeCodeForToken posts form body to the token endpoint", async () => {
  let capturedUrl = "";
  let capturedBody = "";
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedBody = String(init?.body ?? "");
    return new Response(JSON.stringify({ access_token: "at", refresh_token: "rt" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const result = await exchangeCodeForToken({
    config: {
      clientId: "cid",
      clientSecret: "csecret",
      redirectUri: "https://api.example.com/cloudflare/oauth/callback",
      scopes: [],
      intakeBaseUrl: "https://intake.example.com",
    },
    code: "the-code",
    fetchImpl: fakeFetch,
  });

  assert.equal(capturedUrl, "https://dash.cloudflare.com/oauth2/token");
  assert.ok(capturedBody.includes("grant_type=authorization_code"));
  assert.ok(capturedBody.includes("code=the-code"));
  assert.ok(capturedBody.includes("client_id=cid"));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.accessToken, "at");
});

test("listAccounts sends a bearer token and parses the result", async () => {
  let authHeader = "";
  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    authHeader = String((init?.headers as Record<string, string>)?.authorization ?? "");
    return new Response(
      JSON.stringify({ success: true, result: [{ id: "acct-1", name: "Acme" }] }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as unknown as typeof fetch;

  const accounts = await listAccounts("my-token", fakeFetch);
  assert.equal(authHeader, "Bearer my-token");
  assert.deepEqual(accounts, [{ id: "acct-1", name: "Acme" }]);
});

test("createDestination hits the account-scoped destinations endpoint", async () => {
  let capturedUrl = "";
  const fakeFetch = (async (url: string | URL | Request) => {
    capturedUrl = String(url);
    return new Response(JSON.stringify({ success: true, result: { slug: "dest-xyz" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const result = await createDestination({
    accountId: "acct-1",
    accessToken: "at",
    payload: buildDestinationPayload({
      signal: "traces",
      intakeBaseUrl: "https://intake.example.com",
      ingestKey: "sl_public_x",
    }),
    fetchImpl: fakeFetch,
  });

  assert.equal(
    capturedUrl,
    "https://api.cloudflare.com/client/v4/accounts/acct-1/workers/observability/destinations",
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.slug, "dest-xyz");
});

test("deleteDestination DELETEs the slug-scoped endpoint and never throws", async () => {
  let capturedUrl = "";
  let capturedMethod = "";
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedMethod = String(init?.method ?? "");
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;

  const result = await deleteDestination({
    accountId: "acct-1",
    accessToken: "at",
    slug: "Superlog traces",
    fetchImpl: fakeFetch,
  });
  assert.equal(capturedMethod, "DELETE");
  assert.equal(
    capturedUrl,
    "https://api.cloudflare.com/client/v4/accounts/acct-1/workers/observability/destinations/Superlog%20traces",
  );
  assert.equal(result.ok, true);

  // A network throw is swallowed → { ok: false } rather than propagating.
  const boom = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  const failed = await deleteDestination({
    accountId: "acct-1",
    accessToken: "at",
    slug: "x",
    fetchImpl: boom,
  });
  assert.equal(failed.ok, false);
});
