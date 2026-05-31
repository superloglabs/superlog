import { strict as assert } from "node:assert";
import { test } from "node:test";

process.env.DATABASE_URL ??= "postgres://postgres:postgres@localhost:5434/superlog";

const {
  DEFAULT_LOOPS_WELCOME_EVENT,
  buildLoopsContactPayload,
  buildLoopsWelcomeEventPayload,
  sendLoopsWelcomeFlow,
} = await import("@superlog/db");

const input = {
  user: { id: "user_123", email: "founder@acme.test" },
  org: { id: "org_123", name: "Acme Observability", slug: "acme-observability" },
  project: { id: "project_123", name: "Default", slug: "default" },
  signupSource: "skill",
  clerkOrgId: "org_clerk_123",
  appUrl: "https://superlog.sh",
};

test("buildLoopsWelcomeEventPayload includes welcome context for Loops", () => {
  const payload = buildLoopsWelcomeEventPayload(input);

  assert.equal(payload.email, "founder@acme.test");
  assert.equal(payload.userId, "user_123");
  assert.equal(payload.eventName, DEFAULT_LOOPS_WELCOME_EVENT);
  assert.equal(payload.source, "Superlog signup");
  assert.deepEqual(payload.eventProperties, {
    userId: "user_123",
    orgId: "org_123",
    orgName: "Acme Observability",
    orgSlug: "acme-observability",
    projectId: "project_123",
    projectName: "Default",
    projectSlug: "default",
    signupSource: "skill",
    clerkOrgId: "org_clerk_123",
    appUrl: "https://superlog.sh",
  });
});

test("buildLoopsContactPayload mirrors lifecycle flags onto the contact", () => {
  const payload = buildLoopsContactPayload(input, {
    telemetrySet: true,
    telemetrySetAt: "2026-05-11T20:00:00.000Z",
    githubAdded: true,
    githubAddedAt: "2026-05-11T20:01:00.000Z",
    slackAdded: false,
    slackAddedAt: null,
    mcpInstalled: true,
    mcpInstalledAt: "2026-05-11T20:02:00.000Z",
  });

  assert.equal(payload.email, "founder@acme.test");
  assert.equal(payload.userId, "user_123");
  assert.equal(payload.orgName, "Acme Observability");
  assert.equal(payload.telemetrySet, true);
  assert.equal(payload.githubAdded, true);
  assert.equal(payload.slackAdded, false);
  assert.equal(payload.mcpInstalledAt, "2026-05-11T20:02:00.000Z");
});

test("sendLoopsWelcomeFlow skips cleanly without an API key", async () => {
  const result = await sendLoopsWelcomeFlow(input, {
    apiKey: "",
    fetch: async () => {
      throw new Error("fetch should not be called");
    },
  });

  assert.deepEqual(result, { sent: false, reason: "not_configured" });
});

test("sendLoopsWelcomeFlow sends the welcome event to Loops", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;

  const result = await sendLoopsWelcomeFlow(input, {
    apiKey: "loops_secret",
    apiBase: "https://loops.test/api/v1/",
    eventName: "welcomeSignup",
    fetch: async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    },
  });

  assert.deepEqual(result, { sent: true });
  assert.equal(capturedUrl, "https://loops.test/api/v1/events/send");
  assert.equal(capturedInit?.method, "POST");
  assert.equal(
    (capturedInit?.headers as Record<string, string>).authorization,
    "Bearer loops_secret",
  );

  const body = JSON.parse(String(capturedInit?.body));
  assert.equal(body.eventName, "welcomeSignup");
  assert.equal(body.email, "founder@acme.test");
  assert.equal(body.eventProperties.signupSource, "skill");
});

test("sendLoopsWelcomeFlow surfaces Loops API errors", async () => {
  await assert.rejects(
    () =>
      sendLoopsWelcomeFlow(input, {
        apiKey: "loops_secret",
        fetch: async () => new Response("bad key", { status: 401 }),
      }),
    /Loops request failed: 401 bad key/,
  );
});
