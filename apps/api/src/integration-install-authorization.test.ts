import { strict as assert } from "node:assert";
import crypto from "node:crypto";
import { test } from "node:test";
import { Hono } from "hono";

process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";
process.env.BETTER_AUTH_SECRET ??= "test-better-auth-secret-with-enough-length";
process.env.GITHUB_APP_SLUG = "superlog-test";
process.env.SLACK_CLIENT_ID = "slack-client";
process.env.SLACK_CLIENT_SECRET = "slack-secret";
process.env.STATE_SIGNING_SECRET = "state-secret";
process.env.WEB_ORIGIN = "https://app.example.test";

const { mountGithubPublic } = await import("./github.js");
const { mountSlackPublic } = await import("./slack.js");

const device = {
  userId: "owner-user",
  orgId: "owner-org",
  projectId: "owner-project",
};

function installDependencies(currentUserId: () => string | null, canManage: () => boolean) {
  return {
    getAuthenticatedUserId: async () => currentUserId(),
    resolveDevice: () => device,
    hasProjectManagerAccess: async () => canManage(),
  };
}

test("Slack install kickoff rejects an unauthenticated browser", async () => {
  const app = new Hono();
  mountSlackPublic(
    app,
    installDependencies(
      () => null,
      () => true,
    ),
  );

  const response = await app.request("/slack/install?user_code=ABCD-EFGH");

  assert.equal(response.status, 401);
});

test("GitHub install kickoff rejects a user other than the device owner", async () => {
  const app = new Hono();
  mountGithubPublic(
    app,
    installDependencies(
      () => "other-user",
      () => true,
    ),
  );

  const response = await app.request("/github/install?user_code=ABCD-EFGH");

  assert.equal(response.status, 403);
});

test("Slack callback rejects a different authenticated user than the kickoff user", async () => {
  let userId: string | null = device.userId;
  let providerCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    providerCalls++;
    return Response.json({ ok: false, error: "unexpected_exchange" });
  };

  try {
    const app = new Hono();
    mountSlackPublic(
      app,
      installDependencies(
        () => userId,
        () => true,
      ),
    );
    const kickoff = await app.request("/slack/install?user_code=ABCD-EFGH");
    const authorizationUrl = new URL(kickoff.headers.get("location") ?? "");
    const state = authorizationUrl.searchParams.get("state");
    assert.ok(state);

    userId = "other-user";
    const callback = await app.request(
      `/slack/oauth/callback?code=oauth-code&state=${encodeURIComponent(state)}`,
    );

    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get("location"), "https://app.example.test/app?slack=error");
    assert.equal(providerCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GitHub callback rejects the initiating user after project access is revoked", async () => {
  let canManage = true;
  const app = new Hono();
  mountGithubPublic(
    app,
    installDependencies(
      () => device.userId,
      () => canManage,
    ),
  );
  const kickoff = await app.request("/github/install?user_code=ABCD-EFGH");
  const authorizationUrl = new URL(kickoff.headers.get("location") ?? "");
  const state = authorizationUrl.searchParams.get("state");
  assert.ok(state);

  canManage = false;
  const callback = await app.request(
    `/github/install/callback?installation_id=123&state=${encodeURIComponent(state)}`,
  );

  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get("location"), "https://app.example.test/app?gh=error");
});

test("Slack callback rejects legacy device state without an initiating user", async () => {
  const body = `owner-org.owner-project..ABCD-EFGH.${Date.now()}`;
  const signature = crypto.createHmac("sha256", "state-secret").update(body).digest("base64url");
  const state = `${Buffer.from(body, "utf8").toString("base64url")}.${signature}`;
  const app = new Hono();
  mountSlackPublic(
    app,
    installDependencies(
      () => device.userId,
      () => true,
    ),
  );

  const callback = await app.request(
    `/slack/oauth/callback?code=oauth-code&state=${encodeURIComponent(state)}`,
  );

  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get("location"), "https://app.example.test/app?slack=error");
});

test("GitHub callback rejects legacy state authorized only by a user code", async () => {
  const payload = `cli.ABCD-EFGH.${Date.now()}`;
  const signature = crypto.createHmac("sha256", "state-secret").update(payload).digest("base64url");
  const state = `${Buffer.from(payload, "utf8").toString("base64url")}.${signature}`;
  const app = new Hono();
  mountGithubPublic(
    app,
    installDependencies(
      () => device.userId,
      () => true,
    ),
  );

  const callback = await app.request(
    `/github/install/callback?installation_id=123&state=${encodeURIComponent(state)}`,
  );

  assert.equal(callback.status, 400);
});
