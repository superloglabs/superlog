import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Hono } from "hono";
import { listOpenSentryIssues, listSentryProjects, sentryProjectIsAccessible } from "./client.js";
import { signSentryState } from "./oauth.js";

process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";
const {
  completeSentryInstallation,
  exchangeSentryInstallationGrant,
  mountSentryInstallationPublic,
  parseSentryInstallationCallback,
  startSentryOpenIssueImport,
} = await import("./installation.js");

test("routes a Responder callback with every incoming query parameter preserved", async () => {
  const previousDestination = process.env.SENTRY_OAUTH_FORWARD_CALLBACK_URL;
  const destination = "https://responder.example.test/api/integrations/sentry/callback";
  process.env.SENTRY_OAUTH_FORWARD_CALLBACK_URL = destination;
  try {
    const encodedDestination = Buffer.from(destination, "utf8").toString("base64url");
    const state = `responder-v1.${encodedDestination}.one-time-nonce`;
    const rawQuery = `state=${state}&code=grant%2Bcode&installationId=installation-1&orgSlug=acme&extra=one&extra=two`;
    const app = new Hono();
    mountSentryInstallationPublic(app, {
      authorizations: {} as never,
      listProjects: async () => assert.fail("Responder callback must not enter Superlog OAuth"),
      importOpenIssues: async () => assert.fail("Responder callback must not import issues"),
      getActiveCredential: async () => null,
    });

    const response = await app.request(`/sentry/oauth/callback?${rawQuery}`);

    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), `${destination}?${rawQuery}`);
  } finally {
    if (previousDestination === undefined) {
      Reflect.deleteProperty(process.env, "SENTRY_OAUTH_FORWARD_CALLBACK_URL");
    } else process.env.SENTRY_OAUTH_FORWARD_CALLBACK_URL = previousDestination;
  }
});

test("continues through the Superlog callback flow for an ordinary state", async () => {
  const keys = [
    "SENTRY_APP_SLUG",
    "SENTRY_CLIENT_ID",
    "SENTRY_CLIENT_SECRET",
    "STATE_SIGNING_SECRET",
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    const app = new Hono();
    mountSentryInstallationPublic(app, {
      authorizations: {} as never,
      listProjects: async () => [],
      importOpenIssues: async () => 0,
      getActiveCredential: async () => null,
    });

    const response = await app.request(
      "/sentry/oauth/callback?state=ordinary-superlog-state&code=code&installationId=install",
    );

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "sentry not configured" });
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("rejects an invalid Responder state before entering the Superlog callback flow", async () => {
  const previousDestination = process.env.SENTRY_OAUTH_FORWARD_CALLBACK_URL;
  process.env.SENTRY_OAUTH_FORWARD_CALLBACK_URL =
    "https://responder.example.test/api/integrations/sentry/callback";
  try {
    const app = new Hono();
    mountSentryInstallationPublic(app, {
      authorizations: {} as never,
      listProjects: async () =>
        assert.fail("invalid Responder state must not enter Superlog OAuth"),
      importOpenIssues: async () => assert.fail("invalid Responder state must not import issues"),
      getActiveCredential: async () => null,
    });

    const response = await app.request(
      "/sentry/oauth/callback?state=responder-v1.invalid!.nonce&code=code&installationId=install",
    );

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid callback" });
  } finally {
    if (previousDestination === undefined) {
      Reflect.deleteProperty(process.env, "SENTRY_OAUTH_FORWARD_CALLBACK_URL");
    } else process.env.SENTRY_OAUTH_FORWARD_CALLBACK_URL = previousDestination;
  }
});

test("accepts the documented Sentry App callback without an organization slug", () => {
  const state = signSentryState(
    {
      orgId: "org-1",
      projectId: "project-1",
      userId: "user-1",
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
    sentryOAuthRedirect(
      "https://app.superlog.dev",
      "onboarding",
      "choose-project",
      "authorization-1",
      "project-1",
    ),
    "https://app.superlog.dev/?sentry=choose-project&sentryAuthorization=authorization-1&sentryProjectId=project-1",
  );
  assert.equal(
    sentryOAuthRedirect("https://app.superlog.dev", "settings", "denied", undefined, "project-1"),
    "https://app.superlog.dev/settings?scope=project&section=integrations&projectId=project-1&sentry=denied",
  );
  assert.equal(
    sentryOAuthRedirect(
      "https://app.superlog.dev/",
      "settings",
      "choose-project",
      "authorization-1",
      "project-1",
    ),
    "https://app.superlog.dev/settings?scope=project&section=integrations&projectId=project-1&sentry=choose-project&sentryAuthorization=authorization-1",
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

test("discovers every accessible Sentry project for the organization selected in OAuth", async () => {
  const requested: string[] = [];
  const projects = await listSentryProjects({
    accessToken: "token",
    organizationSlug: "acme",
    fetchImpl: async (input, init) => {
      requested.push(String(input));
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer token");
      if (requested.length === 1) {
        return new Response(
          JSON.stringify([
            { id: "1", slug: "storefront", name: "Storefront", hasAccess: true },
            { id: "2", slug: "private", name: "Private", hasAccess: false },
          ]),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              link: '<https://sentry.io/api/0/organizations/acme/projects/?cursor=second>; rel="next"; results="true"',
            },
          },
        );
      }
      return Response.json([
        { id: "3", slug: "worker", name: "Background worker", hasAccess: true },
      ]);
    },
  });

  assert.deepEqual(projects, [
    { id: "1", slug: "storefront", name: "Storefront" },
    { id: "3", slug: "worker", name: "Background worker" },
  ]);
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
