import { strict as assert } from "node:assert";
import crypto from "node:crypto";
import { test } from "node:test";
import { Hono } from "hono";

process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";
process.env.BETTER_AUTH_SECRET ??= "test-better-auth-secret-with-enough-length";
process.env.AGENT_SECRETS_KEY = Buffer.alloc(32, 1).toString("base64");
process.env.STATE_SIGNING_SECRET = "state-secret";
process.env.WEB_ORIGIN = "https://app.example.test";
process.env.GITHUB_APP_SLUG = "superlog-test";
process.env.GITHUB_OAUTH_CLIENT_ID = "gh-client";
process.env.GITHUB_OAUTH_CLIENT_SECRET = "gh-secret";
process.env.LINEAR_CLIENT_ID = "linear-client";
process.env.LINEAR_CLIENT_SECRET = "linear-secret";
process.env.NOTION_CLIENT_ID = "notion-client";
process.env.NOTION_CLIENT_SECRET = "notion-secret";
process.env.SENTRY_CLIENT_ID = "sentry-client";
process.env.SENTRY_CLIENT_SECRET = "sentry-secret";
process.env.SENTRY_APP_SLUG = "superlog-test";

const { signState } = await import("./oauth-state.js");
const { signSentryState } = await import("./sentry/oauth.js");
const { mountLinearPublic } = await import("./linear.js");
const { mountNotionPublic } = await import("./notion.js");
const { mountVercelPublic } = await import("./vercel.js");
const { mountRailwayPublic } = await import("./railway.js");
const { mountCloudflarePublic } = await import("./cloudflare.js");
const { mountSentryInstallationPublic } = await import("./sentry/installation.js");
const { mountProjectMcpOAuthPublic } = await import("./project-mcp-servers.js");
const { mountGithubPublic } = await import("./github.js");

const starter = { orgId: "acme-org", projectId: "acme-project", userId: "acme-admin" };

function callbackAuth(signedInUserId: string | null) {
  return {
    getAuthenticatedUserId: async () => signedInUserId,
    hasProjectManagerAccess: async ({ userId }: { userId: string | null | undefined }) =>
      userId === starter.userId,
    hasOrgManagerAccess: async ({ userId }: { userId: string }) => userId === starter.userId,
  };
}

// Records whether the provider token endpoint was reached, then fails it so the
// flow stops before anything is stored.
function providerFetch() {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    calls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return Response.json({ error: "stop_here" }, { status: 500 });
  }) as typeof fetch;
  return { calls, impl };
}

async function withGlobalFetch<T>(impl: typeof fetch, run: () => T | Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function oauthState(): string {
  return signState(starter, "state-secret");
}

type CallbackCase = {
  name: string;
  path: () => string;
  failureLocation: string;
  // biome-ignore lint/suspicious/noExplicitAny: Hono Variables invariance.
  mount(app: Hono<any>, signedInUserId: string | null, fetchImpl: typeof fetch): void;
};

const cases: CallbackCase[] = [
  {
    name: "Linear",
    path: () => `/linear/oauth/callback?code=oauth-code&state=${encodeURIComponent(oauthState())}`,
    failureLocation: "https://app.example.test/app/settings?linear=error",
    mount: (app, userId) => mountLinearPublic(app, callbackAuth(userId)),
  },
  {
    name: "Notion",
    path: () => `/notion/oauth/callback?code=oauth-code&state=${encodeURIComponent(oauthState())}`,
    failureLocation: "https://app.example.test/app/settings?notion=error",
    mount: (app, userId) => mountNotionPublic(app, callbackAuth(userId)),
  },
  {
    name: "Vercel",
    path: () => `/vercel/oauth/callback?code=oauth-code&state=${encodeURIComponent(oauthState())}`,
    failureLocation: "https://app.example.test/connect/vercel?vercel=error",
    mount: (app, userId, fetchImpl) =>
      mountVercelPublic(app, {
        config: {
          clientId: "vercel-client",
          clientSecret: "vercel-secret",
          integrationSlug: "superlog-test",
          redirectUri: "https://api.example.test/vercel/oauth/callback",
          intakeBaseUrl: "https://intake.example.test",
        },
        fetchImpl,
        callbackAuth: callbackAuth(userId),
      }),
  },
  {
    name: "Railway",
    path: () => `/railway/oauth/callback?code=oauth-code&state=${encodeURIComponent(oauthState())}`,
    failureLocation: "https://app.example.test/connect/railway?railway=error",
    mount: (app, userId, fetchImpl) =>
      mountRailwayPublic(app, {
        config: {
          clientId: "railway-client",
          clientSecret: "railway-secret",
          redirectUri: "https://api.example.test/railway/oauth/callback",
        },
        fetchImpl,
        callbackAuth: callbackAuth(userId),
      }),
  },
  {
    name: "Cloudflare",
    path: () =>
      `/cloudflare/oauth/callback?code=oauth-code&state=${encodeURIComponent(oauthState())}`,
    failureLocation: "https://app.example.test/app?cloudflare=error",
    mount: (app, userId, fetchImpl) =>
      mountCloudflarePublic(app, {
        config: {
          clientId: "cloudflare-client",
          clientSecret: "cloudflare-secret",
          redirectUri: "https://api.example.test/cloudflare/oauth/callback",
          scopes: ["account:read"],
          intakeBaseUrl: "https://intake.example.test",
        },
        fetchImpl,
        callbackAuth: callbackAuth(userId),
      }),
  },
  {
    name: "Sentry",
    path: () => {
      const state = signSentryState({ ...starter, returnTo: "settings" }, "state-secret");
      return `/sentry/oauth/callback?code=oauth-code&installationId=acme-install&state=${encodeURIComponent(state)}`;
    },
    failureLocation:
      "https://app.example.test/settings?scope=project&section=integrations&projectId=acme-project&sentry=error",
    mount: (app, userId) =>
      mountSentryInstallationPublic(app, {
        authorizations: {} as never,
        listProjects: async () => assert.fail("must not list projects"),
        importOpenIssues: async () => assert.fail("must not import issues"),
        getActiveCredential: async () => null,
        callbackAuth: callbackAuth(userId),
      }),
  },
];

for (const callback of cases) {
  for (const [label, signedInUserId] of [
    ["a different signed-in user", "other-user"],
    ["a signed-out browser", null],
  ] as const) {
    test(`${callback.name} callback rejects ${label} before the token exchange`, async () => {
      const provider = providerFetch();
      const app = new Hono();
      callback.mount(app, signedInUserId, provider.impl);

      const response = await withGlobalFetch(provider.impl, () => app.request(callback.path()));

      assert.equal(response.status, 302);
      assert.equal(response.headers.get("location"), callback.failureLocation);
      assert.deepEqual(provider.calls, []);
    });
  }

  test(`${callback.name} callback lets the user who started it reach the token exchange`, async () => {
    const provider = providerFetch();
    const app = new Hono();
    callback.mount(app, starter.userId, provider.impl);

    await withGlobalFetch(provider.impl, () => app.request(callback.path()));

    assert.equal(provider.calls.length, 1);
  });
}

test("Notion callback rejects a state without an initiating user", async () => {
  const provider = providerFetch();
  const app = new Hono();
  mountNotionPublic(app, callbackAuth(starter.userId));
  const state = signState({ ...starter, userId: null }, "state-secret");

  const response = await withGlobalFetch(provider.impl, () =>
    app.request(`/notion/oauth/callback?code=oauth-code&state=${encodeURIComponent(state)}`),
  );

  assert.equal(
    response.headers.get("location"),
    "https://app.example.test/app/settings?notion=error",
  );
  assert.deepEqual(provider.calls, []);
});

type McpAttempt = { projectId: string; initiatingUserId: string | null };

function mcpCallbackApp(signedInUserId: string | null, attempt: McpAttempt) {
  const result: { exchanged: boolean } = { exchanged: false };
  const app = new Hono();
  mountProjectMcpOAuthPublic(app, {
    oauth: {
      complete: async (input) => {
        if (!(await input.authorize(attempt)))
          throw new Error("OAuth attempt is invalid or expired");
        result.exchanged = true;
        return { projectId: attempt.projectId } as never;
      },
    },
    callbackAuth: callbackAuth(signedInUserId),
  });
  return { app, result };
}

const mcpFailure = "https://app.example.test/app/settings?section=agent-mcps&mcp_oauth=error";

test("agent MCP OAuth callback rejects a user other than the one who started it", async () => {
  for (const signedInUserId of ["other-user", null]) {
    const { app, result } = mcpCallbackApp(signedInUserId, {
      projectId: starter.projectId,
      initiatingUserId: starter.userId,
    });

    const response = await app.request("/api/agent-mcp-oauth/callback?state=s&code=c");

    assert.equal(response.headers.get("location"), mcpFailure);
    assert.equal(result.exchanged, false);
  }
});

test("agent MCP OAuth callback completes for the user who started it", async () => {
  const { app, result } = mcpCallbackApp(starter.userId, {
    projectId: starter.projectId,
    initiatingUserId: starter.userId,
  });

  const response = await app.request("/api/agent-mcp-oauth/callback?state=s&code=c");

  const location = new URL(response.headers.get("location") ?? "");
  assert.equal(location.searchParams.get("mcp_oauth"), "connected");
  assert.equal(location.searchParams.get("projectId"), starter.projectId);
  assert.equal(result.exchanged, true);
});

test("agent MCP OAuth callback started with a management key needs a signed-in project manager", async () => {
  const attempt = { projectId: starter.projectId, initiatingUserId: null };
  const outsider = mcpCallbackApp("other-user", attempt);
  const signedOut = mcpCallbackApp(null, attempt);
  const manager = mcpCallbackApp(starter.userId, attempt);

  const outsiderResponse = await outsider.app.request(
    "/api/agent-mcp-oauth/callback?state=s&code=c",
  );
  const signedOutResponse = await signedOut.app.request(
    "/api/agent-mcp-oauth/callback?state=s&code=c",
  );
  await manager.app.request("/api/agent-mcp-oauth/callback?state=s&code=c");

  assert.equal(outsiderResponse.headers.get("location"), mcpFailure);
  assert.equal(signedOutResponse.headers.get("location"), mcpFailure);
  assert.equal(outsider.result.exchanged, false);
  assert.equal(signedOut.result.exchanged, false);
  assert.equal(manager.result.exchanged, true);
});

function signMgmtState(payload: Record<string, unknown>): string {
  const body = `mgmt-v1.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}.${Date.now()}`;
  const signature = crypto.createHmac("sha256", "state-secret").update(body).digest("base64url");
  return `${Buffer.from(body, "utf8").toString("base64url")}.${signature}`;
}

function githubApp(signedInUserId: string | null) {
  const accessChecks: number[] = [];
  const app = new Hono();
  mountGithubPublic(app, {
    ...callbackAuth(signedInUserId),
    userCanAccessInstallation: async ({ installationId }) => {
      accessChecks.push(installationId);
      return { ok: false };
    },
  });
  return { app, accessChecks };
}

test("GitHub dashboard install link rejects a user other than the one who minted it", async () => {
  const state = signMgmtState({
    scope: "org",
    orgId: starter.orgId,
    returnUrl: null,
    userId: starter.userId,
  });
  for (const signedInUserId of ["other-user", null]) {
    const { app, accessChecks } = githubApp(signedInUserId);

    const first = await app.request(
      `/github/install/callback?installation_id=123&state=${encodeURIComponent(state)}`,
    );
    const withCode = await app.request(
      `/github/install/callback?installation_id=123&code=install-code&state=${encodeURIComponent(state)}`,
    );

    assert.equal(first.headers.get("location"), "https://app.example.test/app?gh=error");
    assert.equal(withCode.headers.get("location"), "https://app.example.test/app?gh=error");
    assert.deepEqual(accessChecks, []);
  }
});

test("GitHub dashboard install link continues for the user who minted it", async () => {
  const state = signMgmtState({
    scope: "org",
    orgId: starter.orgId,
    returnUrl: null,
    userId: starter.userId,
  });
  const { app, accessChecks } = githubApp(starter.userId);

  const first = await app.request(
    `/github/install/callback?installation_id=123&state=${encodeURIComponent(state)}`,
  );
  await app.request(
    `/github/install/callback?installation_id=123&code=install-code&state=${encodeURIComponent(state)}`,
  );

  assert.equal(
    new URL(first.headers.get("location") ?? "").origin +
      new URL(first.headers.get("location") ?? "").pathname,
    "https://github.com/login/oauth/authorize",
  );
  assert.deepEqual(accessChecks, [123]);
});

test("GitHub management install failures return to the app, not the return URL", async () => {
  const state = signMgmtState({
    scope: "org",
    orgId: starter.orgId,
    returnUrl: "https://partner.example.test/done",
  });
  const { app } = githubApp(null);

  const missingInstallation = await app.request(
    `/github/install/callback?state=${encodeURIComponent(state)}`,
  );
  const deniedAccess = await app.request(
    `/github/install/callback?installation_id=123&code=install-code&state=${encodeURIComponent(state)}`,
  );

  assert.equal(
    missingInstallation.headers.get("location"),
    "https://app.example.test/app?gh=error",
  );
  assert.equal(deniedAccess.headers.get("location"), "https://app.example.test/app?gh=error");
});
