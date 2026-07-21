import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Hono } from "hono";

// Importing slack.ts pulls in @superlog/db, whose client throws at import time
// when DATABASE_URL is unset. postgres-js connects lazily, so a dummy value is
// enough — the failure branches under test never touch the database.
process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";
process.env.BETTER_AUTH_SECRET ??= "test-better-auth-secret";
process.env.SLACK_CLIENT_ID = "slack-client";
process.env.SLACK_CLIENT_SECRET = "slack-secret";
process.env.STATE_SIGNING_SECRET = "state-secret";
process.env.WEB_ORIGIN = "https://app.example.test";

async function mountCallback(): Promise<Hono> {
  const { mountSlackPublic } = await import("./slack.js");
  const app = new Hono();
  mountSlackPublic(app);
  return app;
}

test("oauth callback with an invalid/expired state redirects back to the app with ?slack=error", async () => {
  const app = await mountCallback();
  // A garbage state fails HMAC verification — the same code path a user hits
  // when their signed state has expired (they lingered >10 min on Slack's
  // consent screen). This must bounce them back to the app with a retryable
  // error, not dead-end on a bare JSON 400.
  const res = await app.request("/slack/oauth/callback?code=abc&state=not-a-valid-state");
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "https://app.example.test/app?slack=error");
});

test("oauth callback with a Slack error param redirects back with ?slack=denied", async () => {
  const app = await mountCallback();
  const res = await app.request("/slack/oauth/callback?error=access_denied");
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "https://app.example.test/app?slack=denied");
});

test("oauth callback with no code redirects back with ?slack=error", async () => {
  const app = await mountCallback();
  const res = await app.request("/slack/oauth/callback?state=whatever");
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "https://app.example.test/app?slack=error");
});
