import { strict as assert } from "node:assert";
import { test } from "node:test";
import { listOpenSentryIssues, sentryProjectIsAccessible } from "./client.js";
import { signSentryState } from "./oauth.js";

process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";
const {
  completeSentryInstallation,
  exchangeSentryInstallationGrant,
  parseSentryInstallationCallback,
  startSentryOpenIssueImport,
} = await import("./installation.js");

test("accepts the documented Sentry App callback without an organization slug", () => {
  const state = signSentryState(
    {
      orgId: "org-1",
      projectId: "project-1",
      userId: "user-1",
      sentryProjectSlug: "storefront",
      returnTo: "onboarding",
    },
    "state-secret",
    1000,
  );

  assert.deepEqual(
    parseSentryInstallationCallback(
      { code: "grant-code", installationId: "installation-1", state },
      "state-secret",
      1001,
    ),
    {
      code: "grant-code",
      installationId: "installation-1",
      state: {
        orgId: "org-1",
        projectId: "project-1",
        userId: "user-1",
        sentryProjectSlug: "storefront",
        returnTo: "onboarding",
      },
    },
  );
});

test("routes an onboarding OAuth callback back into onboarding", async () => {
  const { sentryOAuthRedirect } = await import("./installation.js");
  assert.equal(
    sentryOAuthRedirect("https://app.superlog.dev", "onboarding", "installed"),
    "https://app.superlog.dev/?sentry=installed",
  );
  assert.equal(
    sentryOAuthRedirect("https://app.superlog.dev", "settings", "denied"),
    "https://app.superlog.dev/settings?sentry=denied",
  );
});

test("starts the open-issue import without holding the OAuth redirect open", async () => {
  let finishImport: ((count: number) => void) | undefined;
  const pendingImport = new Promise<number>((resolve) => {
    finishImport = resolve;
  });
  const completed: number[] = [];

  startSentryOpenIssueImport(
    async () => pendingImport,
    (count) => completed.push(count),
    () => assert.fail("import should not fail"),
  );

  assert.deepEqual(completed, []);
  finishImport?.(3);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(completed, [3]);
});

test("exchanges a Sentry App grant on its installation authorization endpoint", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const token = await exchangeSentryInstallationGrant({
    clientId: "client-1",
    clientSecret: "secret-1",
    code: "grant-code",
    installationId: "installation-1",
    fetchImpl: async (input, init) => {
      requests.push({ url: String(input), init: init ?? {} });
      return Response.json(
        {
          token: "access-token",
          refreshToken: "refresh-token",
          expiresAt: "2026-07-21T20:00:00.000Z",
        },
        { status: 201 },
      );
    },
  });

  assert.deepEqual(token, {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: new Date("2026-07-21T20:00:00.000Z"),
  });
  assert.equal(
    requests[0]?.url,
    "https://sentry.io/api/0/sentry-app-installations/installation-1/authorizations/",
  );
  assert.equal(requests[0]?.init.method, "POST");
  assert.deepEqual(JSON.parse(String(requests[0]?.init.body)), {
    grant_type: "authorization_code",
    code: "grant-code",
    client_id: "client-1",
    client_secret: "secret-1",
  });
});

test("completes the Sentry App installation and discovers its organization", async () => {
  const installation = await completeSentryInstallation({
    accessToken: "access-token",
    installationId: "installation-1",
    fetchImpl: async (input, init) => {
      assert.equal(
        String(input),
        "https://sentry.io/api/0/sentry-app-installations/installation-1/",
      );
      assert.equal(init?.method, "PUT");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer access-token");
      assert.deepEqual(JSON.parse(String(init?.body)), { status: "installed" });
      return Response.json({
        uuid: "installation-1",
        status: "installed",
        app: { slug: "superlog" },
        organization: { slug: "acme" },
      });
    },
  });

  assert.deepEqual(installation, {
    installationId: "installation-1",
    appSlug: "superlog",
    organizationSlug: "acme",
  });
});

test("an OAuth install can select a Sentry project after the first cursor page", async () => {
  const requested: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    if (requested.length === 1) {
      return new Response(JSON.stringify([{ slug: "first-project" }]), {
        status: 200,
        headers: {
          "content-type": "application/json",
          link: '<https://sentry.io/api/0/organizations/acme/projects/?cursor=second>; rel="next"; results="true"',
        },
      });
    }
    return new Response(JSON.stringify([{ slug: "storefront" }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const accessible = await sentryProjectIsAccessible({
    accessToken: "token",
    organizationSlug: "acme",
    projectSlug: "storefront",
    fetchImpl,
  });

  assert.equal(accessible, true);
  assert.deepEqual(requested, [
    "https://sentry.io/api/0/organizations/acme/projects/",
    "https://sentry.io/api/0/organizations/acme/projects/?cursor=second",
  ]);
});

test("loads and normalizes every cursor page of unresolved issues for one project", async () => {
  const requested: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requested.push(String(input));
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer token");
    if (requested.length === 1) {
      return new Response(
        JSON.stringify([
          {
            id: "42",
            title: "Checkout failed",
            culprit: "checkout.submit",
            level: "error",
            firstSeen: "2026-07-20T10:00:00Z",
            lastSeen: "2026-07-21T11:00:00Z",
            count: "7",
            permalink: "https://acme.sentry.io/issues/42/",
            project: { slug: "storefront" },
          },
        ]),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            link: '<https://sentry.io/api/0/organizations/acme/issues/?project=storefront&query=is%3Aunresolved&limit=100&cursor=second>; rel="next"; results="true"',
          },
        },
      );
    }
    return Response.json([
      {
        id: "99",
        title: "Worker timed out",
        count: 1,
        project: { slug: "storefront" },
      },
    ]);
  };

  const issues = await listOpenSentryIssues({
    accessToken: "token",
    organizationSlug: "acme",
    projectSlug: "storefront",
    fetchImpl,
  });

  assert.deepEqual(requested, [
    "https://sentry.io/api/0/organizations/acme/issues/?project=storefront&query=is%3Aunresolved&limit=100",
    "https://sentry.io/api/0/organizations/acme/issues/?project=storefront&query=is%3Aunresolved&limit=100&cursor=second",
  ]);
  assert.deepEqual(issues, [
    {
      id: "42",
      title: "Checkout failed",
      culprit: "checkout.submit",
      level: "error",
      firstSeen: "2026-07-20T10:00:00Z",
      lastSeen: "2026-07-21T11:00:00Z",
      count: 7,
      url: "https://acme.sentry.io/issues/42/",
      projectSlug: "storefront",
    },
    {
      id: "99",
      title: "Worker timed out",
      culprit: null,
      level: null,
      firstSeen: null,
      lastSeen: null,
      count: 1,
      url: null,
      projectSlug: "storefront",
    },
  ]);
});
