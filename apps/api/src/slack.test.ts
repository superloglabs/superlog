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

test("parseRateIncidentAction extracts helpful rating and incident id", async () => {
  const { parseRateIncidentAction } = await import("./slack.js");
  assert.deepEqual(parseRateIncidentAction("rate_incident:helpful:inc-1"), {
    rating: "helpful",
    incidentId: "inc-1",
  });
});

test("parseRateIncidentAction extracts unhelpful rating and incident id", async () => {
  const { parseRateIncidentAction } = await import("./slack.js");
  assert.deepEqual(parseRateIncidentAction("rate_incident:unhelpful:inc-1"), {
    rating: "unhelpful",
    incidentId: "inc-1",
  });
});

test("parseRateIncidentAction rejects unknown ratings and other actions", async () => {
  const { parseRateIncidentAction } = await import("./slack.js");
  assert.equal(parseRateIncidentAction("rate_incident:meh:inc-1"), null);
  assert.equal(parseRateIncidentAction("rate_incident:helpful:"), null);
  assert.equal(parseRateIncidentAction("resolve_incident:inc-1"), null);
});

test("parseRetryInvestigationAction extracts only non-empty incident ids", async () => {
  const { parseRetryInvestigationAction } = await import("./slack.js");

  assert.equal(parseRetryInvestigationAction("retry_investigation:incident-1"), "incident-1");
  assert.equal(parseRetryInvestigationAction("retry_investigation:"), null);
  assert.equal(parseRetryInvestigationAction("resolve_incident:incident-1"), null);
});

test("ratingTimelineSummary carries the 👍/👎 signal for the incident timeline", async () => {
  const { ratingTimelineSummary } = await import("./slack.js");
  assert.match(ratingTimelineSummary("helpful"), /^👍 /);
  assert.match(ratingTimelineSummary("unhelpful"), /^👎 /);
});

test("ratingFeedbackBody is plain text — the notifier owns the 👍/👎 badge", async () => {
  const { ratingFeedbackBody } = await import("./slack.js");
  // No emoji baked in: notifyFeedbackSlack prepends a badge from feedback.rating
  // and the admin inbox renders a separate chip, so an emoji here would double up.
  assert.equal(ratingFeedbackBody("helpful"), "Marked helpful");
  assert.equal(ratingFeedbackBody("unhelpful"), "Marked not helpful");
  assert.doesNotMatch(ratingFeedbackBody("helpful"), /👍|👎/);
  assert.doesNotMatch(ratingFeedbackBody("unhelpful"), /👍|👎/);
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

test("invalid Slack credentials revoke the stale installation", async () => {
  const { isRevokedSlackAuthError } = await import("./slack.js");

  for (const error of ["not_authed", "token_revoked", "invalid_auth", "account_inactive"]) {
    assert.equal(isRevokedSlackAuthError(error), true, error);
  }
  assert.equal(isRevokedSlackAuthError("ratelimited"), false);
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

test("project Slack settings are exposed only through an authenticated project-scoped route", async () => {
  const { Hono } = await import("hono");
  const { mountSlackAuthed } = await import("./slack.js");
  const app = new Hono();
  mountSlackAuthed(app);

  const res = await app.request("/api/projects/project-2/slack/installation");

  assert.equal(res.status, 401);
});

test("chat anchors: top-level channel mention roots a thread at its own ts", async () => {
  const { chatAnchorThreadTs } = await import("./slack.js");
  assert.equal(chatAnchorThreadTs({ ts: "111.222" }), "111.222");
});

test("chat anchors: a threaded message anchors on the thread root", async () => {
  const { chatAnchorThreadTs } = await import("./slack.js");
  assert.equal(chatAnchorThreadTs({ ts: "111.333", thread_ts: "111.222" }), "111.222");
});

test("chat anchors: DMs have no thread anchor (one conversation per channel)", async () => {
  const { chatAnchorThreadTs } = await import("./slack.js");
  assert.equal(chatAnchorThreadTs({ ts: "111.222", channel_type: "im" }), null);
  assert.equal(
    chatAnchorThreadTs({ ts: "111.333", thread_ts: "111.222", channel_type: "im" }),
    null,
  );
});

test("resolved incident threads route mentions to Q&A chat", async () => {
  const { slackIncidentThreadRoute } = await import("./slack.js");

  assert.equal(
    slackIncidentThreadRoute({
      incidentStatus: "resolved",
      incidentClosedAt: new Date("2026-07-21T12:00:00.000Z"),
      eventType: "app_mention",
      eventTs: "1784635201.000000",
    }),
    "chat",
  );
  assert.equal(
    slackIncidentThreadRoute({
      incidentStatus: "resolved",
      incidentClosedAt: new Date("2026-07-21T12:00:00.000Z"),
      eventType: "message",
      eventTs: "1784635201.000000",
    }),
    "chat",
  );
});

test("open incident threads continue the investigation from the message event", async () => {
  const { slackIncidentThreadRoute } = await import("./slack.js");

  assert.equal(
    slackIncidentThreadRoute({ incidentStatus: "open", eventType: "message" }),
    "incident",
  );
  assert.equal(
    slackIncidentThreadRoute({ incidentStatus: "open", eventType: "app_mention" }),
    "ignore",
  );
});

test("a mention sent before resolution does not become Q&A when its twin arrives late", async () => {
  const { slackIncidentThreadRoute } = await import("./slack.js");

  assert.equal(
    slackIncidentThreadRoute({
      incidentStatus: "resolved",
      incidentClosedAt: new Date("2026-07-21T12:00:01.000Z"),
      eventType: "app_mention",
      eventTs: "1784635200.500000",
    }),
    "ignore",
  );
  assert.equal(
    slackIncidentThreadRoute({
      incidentStatus: "resolved",
      incidentClosedAt: new Date("2026-07-21T12:00:01.000Z"),
      eventType: "message",
      eventTs: "1784635200.500000",
    }),
    "incident",
  );
});

test("closed incident Q&A keeps the installation that owns the incident", async () => {
  const { findIncidentChatInstallation } = await import("./slack.js");
  const wrongChannelDefault = { id: "install-b", projectId: "project-b" };
  const incidentInstallation = { id: "install-a", projectId: "project-a" };

  assert.equal(
    findIncidentChatInstallation(
      [wrongChannelDefault, incidentInstallation],
      "project-a",
      "install-a",
    ),
    incidentInstallation,
  );
  assert.equal(
    findIncidentChatInstallation(
      [wrongChannelDefault, incidentInstallation],
      "project-a",
      "deleted-install",
    ),
    incidentInstallation,
  );
});

// The bot posts to public channels via chat:write.public WITHOUT joining them,
// but Slack's Events API only delivers message events for channels the bot is
// a member of — so thread replies in a never-joined channel vanish silently.
// joinSlackChannel is the repair: called on install, channel-route changes,
// and re-auth so replies always reach us.
test("joinSlackChannel joins the channel and reports success", async () => {
  const { joinSlackChannel } = await import("./slack.js");
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return { json: async () => ({ ok: true, channel: { id: "C123" } }) } as unknown as Response;
  };

  const result = await joinSlackChannel("xoxb-token", "C123", fetchImpl);

  assert.deepEqual(result, { ok: true });
  assert.equal(calls[0]?.url, "https://slack.com/api/conversations.join");
  assert.deepEqual(calls[0]?.body, { channel: "C123" });
});

test("joinSlackChannel treats already_in_channel as success", async () => {
  const { joinSlackChannel } = await import("./slack.js");
  const fetchImpl: typeof fetch = async () =>
    ({
      json: async () => ({ ok: true, warning: "already_in_channel", channel: { id: "C123" } }),
    }) as unknown as Response;

  assert.deepEqual(await joinSlackChannel("xoxb-token", "C123", fetchImpl), { ok: true });
});

// Legacy installations predate the channels:join scope; the caller uses this
// error to fall back to an "invite the bot" hint instead of failing the flow.
test("joinSlackChannel surfaces the Slack error (missing_scope, private channels)", async () => {
  const { joinSlackChannel } = await import("./slack.js");
  const fetchImpl: typeof fetch = async () =>
    ({ json: async () => ({ ok: false, error: "missing_scope" }) }) as unknown as Response;

  assert.deepEqual(await joinSlackChannel("xoxb-token", "C123", fetchImpl), {
    ok: false,
    error: "missing_scope",
  });
});

test("joinSlackChannel never throws on network failure", async () => {
  const { joinSlackChannel } = await import("./slack.js");
  const fetchImpl: typeof fetch = async () => {
    throw new Error("boom");
  };

  assert.deepEqual(await joinSlackChannel("xoxb-token", "C123", fetchImpl), {
    ok: false,
    error: "network_error",
  });
});
