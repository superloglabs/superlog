import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildSentryAuthorizeUrl, signSentryState, verifySentryState } from "./oauth.js";

test("builds a Sentry Cloud public-app installation URL", () => {
  const url = new URL(
    buildSentryAuthorizeUrl({
      appSlug: "superlog",
      state: "signed-state",
    }),
  );

  assert.equal(url.origin, "https://sentry.io");
  assert.equal(url.pathname, "/sentry-apps/superlog/external-install/");
  assert.equal(url.searchParams.get("state"), "signed-state");
});

test("round-trips the local project through short-lived signed state without a Sentry slug", () => {
  const state = signSentryState(
    {
      orgId: "org-1",
      projectId: "project-1",
      userId: "user-1",
      returnTo: "settings",
    },
    "state-secret",
    1000,
  );

  assert.deepEqual(verifySentryState(state, "state-secret", 1001), {
    orgId: "org-1",
    projectId: "project-1",
    userId: "user-1",
    returnTo: "settings",
  });
  assert.equal(verifySentryState(state, "wrong-secret", 1001), null);
  assert.equal(verifySentryState(state, "state-secret", 1000 + 10 * 60 * 1000 + 1), null);
});
