import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  VERCEL_OAUTH_TOKEN_URL,
  VERCEL_SIGNALS,
  buildDrainPayload,
  buildInstallUrl,
  classifyDrainProvisioningFailure,
  createDrain,
  deleteConfiguration,
  deleteDrain,
  drainName,
  exchangeCodeForToken,
  fetchTeamName,
  parseCreateDrainResponse,
  parseTokenResponse,
  signState,
  staleDrainIds,
  vercelConfigFromEnv,
  verifyState,
} from "./vercel-service.js";

const SECRET = "test-state-secret";

test("vercelConfigFromEnv returns null until required vars are set", () => {
  assert.equal(vercelConfigFromEnv({}), null);
  assert.equal(vercelConfigFromEnv({ VERCEL_CLIENT_ID: "id" }), null);
  assert.equal(
    vercelConfigFromEnv({
      VERCEL_CLIENT_ID: "id",
      VERCEL_CLIENT_SECRET: "secret",
      VERCEL_OTLP_INTAKE_URL: "https://intake.example.com",
    }),
    null,
    "integration slug is required (it forms the install URL)",
  );
  const cfg = vercelConfigFromEnv({
    VERCEL_CLIENT_ID: "id",
    VERCEL_CLIENT_SECRET: "secret",
    VERCEL_INTEGRATION_SLUG: "superlog",
    VERCEL_OTLP_INTAKE_URL: "https://intake.example.com/",
  });
  assert.ok(cfg);
  // trailing slash trimmed; sensible defaults applied
  assert.equal(cfg.intakeBaseUrl, "https://intake.example.com");
  assert.equal(cfg.redirectUri, "http://localhost:4100/vercel/oauth/callback");
  assert.equal(cfg.integrationSlug, "superlog");
});

test("buildInstallUrl targets the integration's external-flow install page with state", () => {
  const url = buildInstallUrl({ integrationSlug: "superlog", state: "signed-state" });
  const u = new URL(url);
  assert.equal(`${u.origin}${u.pathname}`, "https://vercel.com/integrations/superlog/new");
  assert.equal(u.searchParams.get("state"), "signed-state");
});

test("VERCEL_SIGNALS provisions traces and logs", () => {
  assert.deepEqual(VERCEL_SIGNALS, ["traces", "logs"]);
});

test("classifyDrainProvisioningFailure detects Vercel plan-gated drains", () => {
  assert.equal(
    classifyDrainProvisioningFailure([
      "Drains are not available for team 'team_123'",
      "Not authorized",
    ]),
    "drains_unavailable",
  );
  assert.equal(classifyDrainProvisioningFailure(["Not authorized"]), "error");
});

test("drainName is project-scoped so two projects on one team don't collide", () => {
  assert.equal(drainName("aa49a851-b727-4014-bbff-571dc282613c", "traces"), "superlog-aa49a851b727-traces");
  assert.notEqual(
    drainName("aa49a851-b727-4014-bbff-571dc282613c", "traces"),
    drainName("1b480fe1-c652-4c2c-b4d2-593d278124f9", "traces"),
  );
});

test("buildDrainPayload builds an OTLP/HTTP trace drain covering all team projects", () => {
  const payload = buildDrainPayload({
    signal: "traces",
    intakeBaseUrl: "https://intake.example.com",
    ingestKey: "sl_public_abc123",
    projectId: "aa49a851-b727-4014-bbff-571dc282613c",
  });
  assert.equal(payload.name, "superlog-aa49a851b727-traces");
  // All the team's projects stream in; per-project scoping happens on our side
  // via the ingest key → Superlog project mapping.
  assert.equal(payload.projects, "all");
  assert.deepEqual(payload.schemas, { trace: { version: "v1" } });
  assert.equal(payload.delivery.type, "otlphttp");
  assert.deepEqual(payload.delivery.endpoint, {
    traces: "https://intake.example.com/vercel/drains/traces",
  });
  assert.equal(payload.delivery.encoding, "proto");
  assert.equal(payload.delivery.headers["x-api-key"], "sl_public_abc123");
});

test("buildDrainPayload builds an HTTP JSON log drain through the Vercel adapter", () => {
  const payload = buildDrainPayload({
    signal: "logs",
    intakeBaseUrl: "https://intake.example.com",
    ingestKey: "sl_public_abc123",
    projectId: "aa49a851-b727-4014-bbff-571dc282613c",
  });
  assert.equal(payload.name, "superlog-aa49a851b727-logs");
  assert.equal(payload.projects, "all");
  assert.deepEqual(payload.schemas, { log: { version: "v1" } });
  assert.equal(payload.delivery.type, "http");
  assert.equal(payload.delivery.endpoint, "https://intake.example.com/vercel/drains/logs");
  assert.equal(payload.delivery.encoding, "json");
  assert.equal(payload.delivery.headers["x-api-key"], "sl_public_abc123");
});

test("signState/verifyState round-trips and rejects tampering", () => {
  const state = signState({ orgId: "org-1", projectId: "proj-1", userId: "user-1" }, SECRET);
  const decoded = verifyState(state, SECRET);
  assert.ok(decoded);
  assert.equal(decoded.projectId, "proj-1");
  assert.equal(verifyState(state, "other-secret"), null);
});

test("parseTokenResponse extracts the token + installation identifiers", () => {
  const ok = parseTokenResponse({
    access_token: "at",
    token_type: "Bearer",
    installation_id: "icfg_123",
    user_id: "user_abc",
    team_id: "team_xyz",
  });
  assert.deepEqual(ok, {
    ok: true,
    accessToken: "at",
    installationId: "icfg_123",
    userId: "user_abc",
    teamId: "team_xyz",
  });
  // Personal-account installs have no team.
  const personal = parseTokenResponse({
    access_token: "at",
    installation_id: "icfg_123",
    user_id: "user_abc",
    team_id: null,
  });
  assert.ok(personal.ok);
  if (personal.ok) assert.equal(personal.teamId, null);

  assert.deepEqual(parseTokenResponse({ error: "invalid_grant" }), {
    ok: false,
    error: "invalid_grant",
  });
  // Vercel's standard error envelope is an object.
  assert.deepEqual(parseTokenResponse({ error: { code: "bad_request", message: "nope" } }), {
    ok: false,
    error: "nope",
  });
  assert.deepEqual(parseTokenResponse(null), { ok: false, error: "invalid_response" });
  assert.deepEqual(parseTokenResponse({}), { ok: false, error: "no_access_token" });
  // A token without an installation id can't be managed (or torn down) later.
  assert.deepEqual(parseTokenResponse({ access_token: "at" }), {
    ok: false,
    error: "no_installation_id",
  });
});

test("parseCreateDrainResponse returns the drain id and surfaces error messages", () => {
  assert.deepEqual(parseCreateDrainResponse({ id: "drn_1", name: "superlog-x-traces" }), {
    ok: true,
    id: "drn_1",
  });
  assert.deepEqual(parseCreateDrainResponse({ error: { code: "forbidden", message: "nope" } }), {
    ok: false,
    error: "nope",
  });
  assert.deepEqual(parseCreateDrainResponse({ error: { code: "forbidden" } }), {
    ok: false,
    error: "forbidden",
  });
  assert.deepEqual(parseCreateDrainResponse(null), { ok: false, error: "invalid_response" });
  // A drain we can't identify can't be deleted on reconnect/uninstall — treat a
  // response without an id as a failure rather than persist an unmanageable drain.
  assert.deepEqual(parseCreateDrainResponse({ name: "superlog-x-traces" }), {
    ok: false,
    error: "no_drain_id",
  });
});

test("staleDrainIds only deletes prior ids for signals that got a replacement", () => {
  assert.deepEqual(staleDrainIds(null, { traces: "new-1" }), {});
  assert.deepEqual(staleDrainIds({ traces: "old-t" }, { traces: "new-t" }), { traces: "old-t" });
  // `traces` failed to recreate (absent from current) → its prior id is KEPT.
  assert.deepEqual(staleDrainIds({ traces: "old-t" }, {}), {});
  // Same id returned (idempotent create) → it's the live one, keep it.
  assert.deepEqual(staleDrainIds({ traces: "same" }, { traces: "same" }), {});
});

test("exchangeCodeForToken posts form body to the token endpoint", async () => {
  let capturedUrl = "";
  let capturedBody = "";
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedBody = String(init?.body ?? "");
    return new Response(
      JSON.stringify({
        access_token: "at",
        installation_id: "icfg_1",
        user_id: "u1",
        team_id: "t1",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  const result = await exchangeCodeForToken({
    config: {
      clientId: "cid",
      clientSecret: "csecret",
      integrationSlug: "superlog",
      redirectUri: "https://api.example.com/vercel/oauth/callback",
      intakeBaseUrl: "https://intake.example.com",
    },
    code: "the-code",
    fetchImpl: fakeFetch,
  });

  assert.equal(capturedUrl, VERCEL_OAUTH_TOKEN_URL);
  assert.ok(capturedBody.includes("code=the-code"));
  assert.ok(capturedBody.includes("client_id=cid"));
  assert.ok(capturedBody.includes("redirect_uri="));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.accessToken, "at");
});

test("createDrain POSTs to /v1/drains with the team query when installed on a team", async () => {
  let capturedUrl = "";
  let authHeader = "";
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(url);
    authHeader = String((init?.headers as Record<string, string>)?.authorization ?? "");
    return new Response(JSON.stringify({ id: "drn_9" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const result = await createDrain({
    teamId: "team_1",
    accessToken: "at",
    payload: buildDrainPayload({
      signal: "traces",
      intakeBaseUrl: "https://intake.example.com",
      ingestKey: "sl_public_x",
      projectId: "aa49a851-b727-4014-bbff-571dc282613c",
    }),
    fetchImpl: fakeFetch,
  });

  assert.equal(capturedUrl, "https://api.vercel.com/v1/drains?teamId=team_1");
  assert.equal(authHeader, "Bearer at");
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.id, "drn_9");
});

test("createDrain omits the team query for personal-account installs", async () => {
  let capturedUrl = "";
  const fakeFetch = (async (url: string | URL | Request) => {
    capturedUrl = String(url);
    return new Response(JSON.stringify({ id: "drn_9" }), { status: 200 });
  }) as unknown as typeof fetch;

  await createDrain({
    teamId: null,
    accessToken: "at",
    payload: buildDrainPayload({
      signal: "traces",
      intakeBaseUrl: "https://intake.example.com",
      ingestKey: "k",
      projectId: "p",
    }),
    fetchImpl: fakeFetch,
  });
  assert.equal(capturedUrl, "https://api.vercel.com/v1/drains");
});

test("deleteDrain DELETEs the drain and never throws", async () => {
  let capturedUrl = "";
  let capturedMethod = "";
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedMethod = String(init?.method ?? "");
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;

  const result = await deleteDrain({
    teamId: "team_1",
    accessToken: "at",
    drainId: "drn_9",
    fetchImpl: fakeFetch,
  });
  assert.equal(capturedMethod, "DELETE");
  assert.equal(capturedUrl, "https://api.vercel.com/v1/drains/drn_9?teamId=team_1");
  assert.equal(result.ok, true);

  const boom = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  const failed = await deleteDrain({
    teamId: null,
    accessToken: "at",
    drainId: "x",
    fetchImpl: boom,
  });
  assert.equal(failed.ok, false);
});

test("deleteConfiguration removes the integration install and never throws", async () => {
  let capturedUrl = "";
  let capturedMethod = "";
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedMethod = String(init?.method ?? "");
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;

  const result = await deleteConfiguration({
    teamId: "team_1",
    accessToken: "at",
    configurationId: "icfg_1",
    fetchImpl: fakeFetch,
  });
  assert.equal(capturedMethod, "DELETE");
  assert.equal(
    capturedUrl,
    "https://api.vercel.com/v1/integrations/configuration/icfg_1?teamId=team_1",
  );
  assert.equal(result.ok, true);

  const boom = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  const failed = await deleteConfiguration({
    teamId: null,
    accessToken: "at",
    configurationId: "icfg_1",
    fetchImpl: boom,
  });
  assert.equal(failed.ok, false);
});

test("fetchTeamName resolves the team display name and null on any failure", async () => {
  const respond = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  assert.equal(
    await fetchTeamName({
      teamId: "team_1",
      accessToken: "at",
      fetchImpl: respond(200, { id: "team_1", name: "Acme", slug: "acme" }),
    }),
    "Acme",
  );
  // Fall back to the slug when the name is empty.
  assert.equal(
    await fetchTeamName({
      teamId: "team_1",
      accessToken: "at",
      fetchImpl: respond(200, { id: "team_1", slug: "acme" }),
    }),
    "acme",
  );
  assert.equal(
    await fetchTeamName({
      teamId: "team_1",
      accessToken: "at",
      fetchImpl: respond(403, { error: { code: "forbidden" } }),
    }),
    null,
  );
  // Personal installs have no team to look up.
  assert.equal(await fetchTeamName({ teamId: null, accessToken: "at", fetchImpl: fetch }), null);
});
