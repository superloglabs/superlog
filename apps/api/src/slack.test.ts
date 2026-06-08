import { strict as assert } from "node:assert";
import { test } from "node:test";

// slack.ts transitively imports the db client, which throws at import time
// without a connection string. Set a dummy URL before the dynamic import (the
// porsager client connects lazily, so these pure-function tests never open a
// socket). Same dynamic-import pattern as detail.test.ts / loops.test.ts.
process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";
process.env.BETTER_AUTH_SECRET ??= "test-better-auth-secret-with-enough-length";
const { preferPinnedInstallation } = await import("./slack.js");

type FakeResponse = { ok: boolean; channels?: unknown[]; error?: string; cursor?: string };

function fakeFetch(pages: FakeResponse[]) {
  const calls: URL[] = [];
  let i = 0;
  const fetchImpl: typeof fetch = async (input) => {
    calls.push(input as URL);
    const page = pages[i++] ?? { ok: true, channels: [] };
    const body: Record<string, unknown> = { ok: page.ok };
    if (page.error) body.error = page.error;
    if (page.channels) body.channels = page.channels;
    if (page.cursor) body.response_metadata = { next_cursor: page.cursor };
    return { json: async () => body } as unknown as Response;
  };
  return { fetchImpl, calls };
}

// Regression guard: a workspace installed into multiple Superlog projects owns
// several non-revoked `slack_installations` rows (upsertInstallation keys by
// project). Slack only keeps the most-recently-refreshed bot token live, so an
// unordered team-wide lookup can hand back a stale row whose token fails every
// API call with `invalid_auth` — which is exactly what broke the incident
// feedback modal (views.open -> invalid_auth). Incidents/proposals pin the
// exact installation that posted their thread, so that pin must win.
test("prefers the installation pinned to the incident over a team-wide match", () => {
  const pinned = { id: "pinned", botAccessToken: "live" };
  const teamFallback = { id: "other", botAccessToken: "stale" };
  assert.equal(preferPinnedInstallation(pinned, teamFallback), pinned);
});

test("falls back to the team match when the incident has no pinned installation", () => {
  const teamFallback = { id: "other", botAccessToken: "stale" };
  assert.equal(preferPinnedInstallation(null, teamFallback), teamFallback);
});

test("returns null when neither a pin nor a team match resolves", () => {
  assert.equal(preferPinnedInstallation(null, null), null);
});

test("Slack resolve clicks on noise incidents refresh resolved-side effects", async () => {
  const { resolveSlackResolveClickDisposition } = await import("./slack.js");

  assert.equal(resolveSlackResolveClickDisposition("autoresolved_noise"), "refresh_side_effects");
});

test("Slack resolve clicks on open incidents perform a fresh resolve", async () => {
  const { resolveSlackResolveClickDisposition } = await import("./slack.js");

  assert.equal(resolveSlackResolveClickDisposition("open"), "resolve");
});

test("listSlackChannels requests both public and private channels", async () => {
  const { listSlackChannels } = await import("./slack.js");
  const { fetchImpl, calls } = fakeFetch([{ ok: true, channels: [] }]);

  await listSlackChannels("xoxb-token", fetchImpl);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.searchParams.get("types"), "public_channel,private_channel");
  assert.equal(calls[0]?.searchParams.get("exclude_archived"), "true");
});

test("listSlackChannels follows cursor pagination and aggregates all channels", async () => {
  const { listSlackChannels } = await import("./slack.js");
  const { fetchImpl, calls } = fakeFetch([
    {
      ok: true,
      channels: [{ id: "C1", name: "general", is_private: false }],
      cursor: "page2",
    },
    {
      ok: true,
      channels: [{ id: "G1", name: "secret-room", is_private: true }],
    },
  ]);

  const result = await listSlackChannels("xoxb-token", fetchImpl);

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.searchParams.get("cursor"), "page2");
  assert.ok(result.ok);
  assert.deepEqual(result.channels, [
    { id: "C1", name: "general", isPrivate: false },
    { id: "G1", name: "secret-room", isPrivate: true },
  ]);
  // the private channel must survive into the final list
  assert.ok(result.channels.some((c) => c.isPrivate && c.name === "secret-room"));
});

test("listSlackChannels returns the Slack error without paginating further", async () => {
  const { listSlackChannels } = await import("./slack.js");
  const { fetchImpl, calls } = fakeFetch([{ ok: false, error: "token_revoked" }]);

  const result = await listSlackChannels("xoxb-token", fetchImpl);

  assert.equal(result.ok, false);
  assert.equal(calls.length, 1);
  assert.ok(!result.ok);
  assert.equal(result.error, "token_revoked");
});

// Regression guard: clicking Send on the Slack incident feedback modal kept
// surfacing "We had some trouble connecting. Try again?". Slack's
// view_submission ack contract requires an EMPTY 200 body to close the modal;
// our route was returning `{"ok":true}`, which Slack treats as an invalid
// response and refuses to close. The ack body must be empty.
test("view_submission ack is an empty 200 body (closes the Slack modal)", async () => {
  const { Hono } = await import("hono");
  const { mountSlackPublic } = await import("./slack.js");

  const secret = "test-slack-signing-secret";
  process.env.SLACK_SIGNING_SECRET = secret;

  const app = new Hono();
  mountSlackPublic(app);

  // Empty feedback value → handler returns before any DB access, isolating the
  // ack-body behavior we care about.
  const payload = {
    type: "view_submission",
    view: {
      callback_id: "feedback_modal:incident-123",
      state: { values: { feedback_body: { value: { value: "" } } } },
    },
    user: { id: "U1" },
    team: { id: "T1" },
  };
  const rawBody = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const ts = Math.floor(Date.now() / 1000).toString();
  const crypto = await import("node:crypto");
  const sig = `v0=${crypto
    .createHmac("sha256", secret)
    .update(`v0:${ts}:${rawBody}`)
    .digest("hex")}`;

  const res = await app.request("/slack/interactivity", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-signature": sig,
      "x-slack-request-timestamp": ts,
    },
    body: rawBody,
  });

  assert.equal(res.status, 200);
  assert.equal(await res.text(), "");
});

test("listSlackChannels returns an error when the page cap is exhausted", async () => {
  const { listSlackChannels } = await import("./slack.js");
  const { fetchImpl, calls } = fakeFetch(
    Array.from({ length: 50 }, (_, i) => ({
      ok: true,
      channels: [{ id: `C${i}`, name: `channel-${i}` }],
      cursor: `page-${i + 1}`,
    })),
  );

  const result = await listSlackChannels("xoxb-token", fetchImpl);

  assert.equal(calls.length, 50);
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.equal(result.error, "pagination_limit_exceeded");
});
