import { strict as assert } from "node:assert";
import crypto from "node:crypto";
import { test } from "node:test";
import { Hono } from "hono";
import { SENTRY_WEBHOOK_BODY_BYTES, mountSentryPublic } from "./http.js";

test("accepts a signed new Sentry issue without doing incident work inline", async () => {
  const secret = "test-sentry-client-secret";
  const body = JSON.stringify({
    action: "created",
    installation: { uuid: "installation-1" },
    data: {
      issue: {
        id: "issue-42",
        title: "Checkout failed",
        culprit: "checkout.submit",
        level: "error",
        firstSeen: "2026-07-21T11:00:00.000Z",
        lastSeen: "2026-07-21T11:00:00.000Z",
        count: "1",
        permalink: "https://acme.sentry.io/issues/42/",
        project: { slug: "storefront" },
      },
    },
  });
  const signature = crypto.createHmac("sha256", secret).update(body).digest("hex");
  const received: unknown[] = [];
  const app = new Hono();
  mountSentryPublic(app, {
    clientSecret: secret,
    receiveIssueEvent: async (event) => {
      received.push(event);
    },
  });

  const response = await app.request("/sentry/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sentry-hook-resource": "issue",
      "sentry-hook-signature": signature,
    },
    body,
  });

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { accepted: true });
  assert.deepEqual(received, [
    {
      action: "created",
      installationId: "installation-1",
      rawBody: body,
      issue: {
        id: "issue-42",
        title: "Checkout failed",
        culprit: "checkout.submit",
        level: "error",
        firstSeen: "2026-07-21T11:00:00.000Z",
        lastSeen: "2026-07-21T11:00:00.000Z",
        count: 1,
        url: "https://acme.sentry.io/issues/42/",
        projectSlug: "storefront",
      },
    },
  ]);
});

test("forwards a signed Sentry webhook even when the local receiver has no matching installation", async () => {
  const secret = "test-sentry-client-secret";
  const rawBody = new TextEncoder().encode(
    JSON.stringify({
      action: "created",
      installation: { uuid: "external-only" },
      data: {
        issue: {
          id: "issue-42",
          title: "External app issue",
          project: { slug: "external-project" },
        },
      },
    }),
  );
  const signature = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const forwarded: unknown[] = [];
  const app = new Hono();
  mountSentryPublic(app, {
    clientSecret: secret,
    receiveIssueEvent: async () => undefined,
    forwardWebhook: async (delivery) => {
      forwarded.push(delivery);
    },
  });

  const response = await app.request("/sentry/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "request-id": "request-42",
      "sentry-hook-id": "hook-42",
      "sentry-hook-resource": "issue",
      "sentry-hook-signature": signature,
    },
    body: rawBody,
  });

  assert.equal(response.status, 202);
  assert.deepEqual(forwarded, [
    {
      rawBody,
      headers: {
        "content-type": "application/json",
        "request-id": "request-42",
        "sentry-hook-id": "hook-42",
        "sentry-hook-resource": "issue",
        "sentry-hook-signature": signature,
      },
    },
  ]);
});

test("does not forward a webhook that already came from the multiplexer", async () => {
  const secret = "test-sentry-client-secret";
  const body = JSON.stringify({ action: "assigned", installation: { uuid: "external-only" } });
  const signature = crypto.createHmac("sha256", secret).update(body).digest("hex");
  let forwardAttempts = 0;
  const app = new Hono();
  mountSentryPublic(app, {
    clientSecret: secret,
    receiveIssueEvent: async () =>
      assert.fail("unsupported issue action must not be handled locally"),
    forwardWebhook: async () => {
      forwardAttempts += 1;
    },
  });

  const response = await app.request("/sentry/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sentry-hook-resource": "issue",
      "sentry-hook-signature": signature,
      "x-superlog-sentry-webhook-forwarded": "1",
    },
    body,
  });

  assert.equal(response.status, 202);
  assert.equal(forwardAttempts, 0);
});

test("does not forward a webhook whose Sentry signature is invalid", async () => {
  let forwardAttempts = 0;
  const app = new Hono();
  mountSentryPublic(app, {
    clientSecret: "test-sentry-client-secret",
    receiveIssueEvent: async () => assert.fail("invalid webhook must not be handled locally"),
    forwardWebhook: async () => {
      forwardAttempts += 1;
    },
  });

  const response = await app.request("/sentry/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sentry-hook-resource": "issue",
      "sentry-hook-signature": "invalid",
    },
    body: "{}",
  });

  assert.equal(response.status, 401);
  assert.equal(forwardAttempts, 0);
});

test("still delivers locally when the forwarded webhook fails", async () => {
  const secret = "test-sentry-client-secret";
  const rawBody = JSON.stringify({
    action: "created",
    installation: { uuid: "installation-1" },
    data: {
      issue: {
        id: "issue-42",
        title: "Checkout failed",
        project: { slug: "storefront" },
      },
    },
  });
  const signature = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  let deliveredLocally = false;
  const app = new Hono();
  app.onError((_error, c) => c.json({ error: "delivery failed" }, 502));
  mountSentryPublic(app, {
    clientSecret: secret,
    receiveIssueEvent: async () => {
      deliveredLocally = true;
    },
    forwardWebhook: async () => {
      throw new Error("Responder unavailable");
    },
  });

  const response = await app.request("/sentry/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sentry-hook-resource": "issue",
      "sentry-hook-signature": signature,
    },
    body: rawBody,
  });

  assert.equal(response.status, 502);
  assert.equal(deliveredLocally, true);
});

test("still forwards the webhook when local delivery fails", async () => {
  const secret = "test-sentry-client-secret";
  const rawBody = JSON.stringify({
    action: "created",
    installation: { uuid: "installation-1" },
    data: {
      issue: {
        id: "issue-42",
        title: "Checkout failed",
        project: { slug: "storefront" },
      },
    },
  });
  const signature = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  let forwarded = false;
  const app = new Hono();
  app.onError((_error, c) => c.json({ error: "delivery failed" }, 502));
  mountSentryPublic(app, {
    clientSecret: secret,
    receiveIssueEvent: async () => {
      throw new Error("Superlog delivery failed");
    },
    forwardWebhook: async () => {
      forwarded = true;
    },
  });

  const response = await app.request("/sentry/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sentry-hook-resource": "issue",
      "sentry-hook-signature": signature,
    },
    body: rawBody,
  });

  assert.equal(response.status, 502);
  assert.equal(forwarded, true);
});

test("accepts a signed Sentry App uninstall so stale project connections are revoked", async () => {
  const secret = "test-sentry-client-secret";
  const body = JSON.stringify({ action: "deleted", installation: { uuid: "installation-1" } });
  const signature = crypto.createHmac("sha256", secret).update(body).digest("hex");
  const revoked: string[] = [];
  const app = new Hono();
  mountSentryPublic(app, {
    clientSecret: secret,
    receiveIssueEvent: async () => assert.fail("not an issue event"),
    revokeInstallation: async (installationId) => {
      revoked.push(installationId);
    },
  });

  const response = await app.request("/sentry/webhook", {
    method: "POST",
    headers: {
      "sentry-hook-resource": "installation",
      "sentry-hook-signature": signature,
    },
    body,
  });

  assert.equal(response.status, 202);
  assert.deepEqual(revoked, ["installation-1"]);
});

test("rejects an oversized public Sentry webhook before reading or handling it", async () => {
  let handled = false;
  const app = new Hono();
  mountSentryPublic(app, {
    clientSecret: "test-sentry-client-secret",
    receiveIssueEvent: async () => {
      handled = true;
    },
  });

  const response = await app.request("/sentry/webhook", {
    method: "POST",
    headers: {
      "content-length": String(SENTRY_WEBHOOK_BODY_BYTES + 1),
      "content-type": "application/json",
    },
    body: "{}",
  });

  assert.equal(response.status, 413);
  assert.equal(handled, false);
  assert.deepEqual(await response.json(), { error: "payload too large" });
});
