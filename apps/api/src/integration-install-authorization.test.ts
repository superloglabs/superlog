import { strict as assert } from "node:assert";
import crypto from "node:crypto";
import { test } from "node:test";
import { Hono } from "hono";

process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";
process.env.BETTER_AUTH_SECRET ??= "test-better-auth-secret-with-enough-length";
process.env.GITHUB_APP_SLUG = "superlog-test";
process.env.SLACK_CLIENT_ID = "slack-client";
process.env.SLACK_CLIENT_SECRET = "slack-secret";
process.env.AGENT_SECRETS_KEY = Buffer.alloc(32, 1).toString("base64");
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

function signMgmtOrgState(orgId: string): string {
  const body = `mgmt-v1.${Buffer.from(JSON.stringify({ scope: "org", orgId, returnUrl: null }), "utf8").toString("base64url")}.${Date.now()}`;
  const signature = crypto.createHmac("sha256", "state-secret").update(body).digest("base64url");
  return `${Buffer.from(body, "utf8").toString("base64url")}.${signature}`;
}

function withGithubOAuthEnv<T>(run: () => Promise<T>): Promise<T> {
  const previous = {
    id: process.env.GITHUB_OAUTH_CLIENT_ID,
    secret: process.env.GITHUB_OAUTH_CLIENT_SECRET,
    redirect: process.env.GITHUB_AUTHOR_OAUTH_REDIRECT_URL,
  };
  process.env.GITHUB_OAUTH_CLIENT_ID = "gh-client";
  process.env.GITHUB_OAUTH_CLIENT_SECRET = "gh-secret";
  process.env.GITHUB_AUTHOR_OAUTH_REDIRECT_URL = "https://api.example.test/github/author/callback";
  return run().finally(() => {
    for (const [key, value] of [
      ["GITHUB_OAUTH_CLIENT_ID", previous.id],
      ["GITHUB_OAUTH_CLIENT_SECRET", previous.secret],
      ["GITHUB_AUTHOR_OAUTH_REDIRECT_URL", previous.redirect],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("GitHub callback asks the user to authorize before linking an installation", () =>
  withGithubOAuthEnv(async () => {
    let checks = 0;
    const app = new Hono();
    mountGithubPublic(app, {
      ...installDependencies(
        () => device.userId,
        () => true,
      ),
      userCanAccessInstallation: async () => {
        checks++;
        return { ok: false };
      },
    });
    const kickoff = await app.request("/github/install?user_code=ABCD-EFGH");
    const state = new URL(kickoff.headers.get("location") ?? "").searchParams.get("state");
    assert.ok(state);

    const callback = await app.request(
      `/github/install/callback?installation_id=123&state=${encodeURIComponent(state)}`,
    );

    assert.equal(callback.status, 302);
    const location = new URL(callback.headers.get("location") ?? "");
    assert.equal(location.origin + location.pathname, "https://github.com/login/oauth/authorize");
    assert.equal(location.searchParams.get("client_id"), "gh-client");
    assert.equal(
      location.searchParams.get("redirect_uri"),
      "https://api.example.test/github/author/callback",
    );
    assert.ok(location.searchParams.get("state"));
    assert.equal(checks, 0);
  }));

test("GitHub callback refuses an installation the user cannot access", () =>
  withGithubOAuthEnv(async () => {
    const seen: number[] = [];
    const app = new Hono();
    mountGithubPublic(app, {
      ...installDependencies(
        () => device.userId,
        () => true,
      ),
      userCanAccessInstallation: async ({ installationId, redirectUrl }) => {
        seen.push(installationId);
        assert.equal(redirectUrl, "https://api.example.test/github/author/callback");
        return { ok: false };
      },
    });
    const kickoff = await app.request("/github/install?user_code=ABCD-EFGH");
    const state = new URL(kickoff.headers.get("location") ?? "").searchParams.get("state");
    assert.ok(state);
    const first = await app.request(
      `/github/install/callback?installation_id=123&state=${encodeURIComponent(state)}`,
    );
    const confirmState = new URL(first.headers.get("location") ?? "").searchParams.get("state");
    assert.ok(confirmState);

    const callback = await app.request(
      `/github/install/callback?code=user-code&state=${encodeURIComponent(confirmState)}`,
    );

    assert.equal(callback.status, 302);
    assert.equal(
      callback.headers.get("location"),
      "https://app.example.test/activate?code=ABCD-EFGH&gh=error",
    );
    assert.deepEqual(seen, [123]);
  }));

test("GitHub callback ignores an installation id swapped in on the way back", () =>
  withGithubOAuthEnv(async () => {
    const seen: number[] = [];
    const app = new Hono();
    mountGithubPublic(app, {
      ...installDependencies(
        () => device.userId,
        () => true,
      ),
      userCanAccessInstallation: async ({ installationId }) => {
        seen.push(installationId);
        return { ok: false };
      },
    });
    const kickoff = await app.request("/github/install?user_code=ABCD-EFGH");
    const state = new URL(kickoff.headers.get("location") ?? "").searchParams.get("state");
    assert.ok(state);
    const first = await app.request(
      `/github/install/callback?installation_id=123&state=${encodeURIComponent(state)}`,
    );
    const confirmState = new URL(first.headers.get("location") ?? "").searchParams.get("state");
    assert.ok(confirmState);

    await app.request(
      `/github/install/callback?installation_id=999&code=user-code&state=${encodeURIComponent(confirmState)}`,
    );

    assert.deepEqual(seen, [123]);
  }));

test("GitHub management callback also requires the user's GitHub access", () =>
  withGithubOAuthEnv(async () => {
    let checks = 0;
    const app = new Hono();
    mountGithubPublic(app, {
      ...installDependencies(
        () => null,
        () => false,
      ),
      userCanAccessInstallation: async () => {
        checks++;
        return { ok: false };
      },
    });
    const state = signMgmtOrgState("platform-org");

    const first = await app.request(
      `/github/install/callback?installation_id=456&state=${encodeURIComponent(state)}`,
    );
    const authorize = new URL(first.headers.get("location") ?? "");
    assert.equal(authorize.origin, "https://github.com");
    const confirmState = authorize.searchParams.get("state");
    assert.ok(confirmState);

    const callback = await app.request(
      `/github/install/callback?code=user-code&state=${encodeURIComponent(confirmState)}`,
    );
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get("location"), "https://app.example.test/app?gh=error");
    assert.equal(checks, 1);
  }));

test("GitHub callback refuses an install code that does not cover the installation", () =>
  withGithubOAuthEnv(async () => {
    const redirects: string[] = [];
    const app = new Hono();
    mountGithubPublic(app, {
      ...installDependencies(
        () => null,
        () => false,
      ),
      userCanAccessInstallation: async ({ redirectUrl }) => {
        redirects.push(redirectUrl);
        return { ok: false };
      },
    });
    const state = signMgmtOrgState("platform-org");

    const callback = await app.request(
      `/github/install/callback?installation_id=456&code=install-code&state=${encodeURIComponent(state)}`,
    );

    assert.equal(callback.headers.get("location"), "https://app.example.test/app?gh=error");
    assert.deepEqual(redirects, ["http://localhost:4100/github/install/callback"]);
  }));

test("GitHub author callback hands install confirmations back to the install callback", () =>
  withGithubOAuthEnv(async () => {
    const { mountGithubAuthorOAuth } = await import("./github.js");
    const app = new Hono();
    mountGithubPublic(app, {
      ...installDependencies(
        () => null,
        () => false,
      ),
      userCanAccessInstallation: async () => ({ ok: false }),
    });
    mountGithubAuthorOAuth(app);
    const first = await app.request(
      `/github/install/callback?installation_id=456&state=${encodeURIComponent(signMgmtOrgState("platform-org"))}`,
    );
    const confirmState = new URL(first.headers.get("location") ?? "").searchParams.get("state");
    assert.ok(confirmState);

    const query = `code=user-code&state=${encodeURIComponent(confirmState)}`;
    const hop = await app.request(`/github/author/callback?${query}`);

    assert.equal(hop.status, 302);
    assert.equal(hop.headers.get("location"), `/github/install/callback?${query}`);
  }));
