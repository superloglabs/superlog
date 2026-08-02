import assert from "node:assert/strict";
import { test } from "node:test";
import { createSentryWebhookForwarder } from "./forwarder.js";

test("rejects a malformed forwarding destination when the API starts", () => {
  assert.throws(
    () => createSentryWebhookForwarder({ destinationUrl: "private destination" }),
    /Sentry webhook forwarding destination must be an HTTP URL/,
  );
});

test("forwards the signed Sentry delivery to the configured private destination", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const forwardWebhook = createSentryWebhookForwarder({
    destinationUrl: "https://other-app.example.test/sentry/webhook",
    fetchImpl: async (input, init = {}) => {
      requests.push({ url: String(input), init });
      return new Response(null, { status: 202 });
    },
  });

  assert.ok(forwardWebhook);
  const rawBody = new Uint8Array([123, 10, 32, 32, 125]);
  await forwardWebhook({
    rawBody,
    headers: {
      "content-type": "application/json",
      "request-id": "request-42",
      "sentry-hook-resource": "issue",
      "sentry-hook-signature": "signature",
    },
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "https://other-app.example.test/sentry/webhook");
  assert.equal(requests[0]?.init.method, "POST");
  assert.deepEqual(requests[0]?.init.body, rawBody);
  assert.deepEqual(requests[0]?.init.headers, {
    "content-type": "application/json",
    "request-id": "request-42",
    "sentry-hook-resource": "issue",
    "sentry-hook-signature": "signature",
    "x-superlog-sentry-webhook-forwarded": "1",
  });
});

test("fails the source delivery when the configured destination rejects the webhook", async () => {
  const forwardWebhook = createSentryWebhookForwarder({
    destinationUrl: "https://other-app.example.test/sentry/webhook",
    fetchImpl: async () => new Response(null, { status: 503 }),
  });

  assert.ok(forwardWebhook);
  await assert.rejects(
    forwardWebhook({
      rawBody: new TextEncoder().encode("{}"),
      headers: { "sentry-hook-signature": "signature" },
    }),
    /Sentry webhook forwarding failed \(503\)/,
  );
});

test("bounds how long the source delivery waits for the configured destination", async () => {
  const forwardWebhook = createSentryWebhookForwarder({
    destinationUrl: "https://other-app.example.test/sentry/webhook",
    timeoutMs: 5,
    fetchImpl: async (_input, init = {}) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      }),
  });

  assert.ok(forwardWebhook);
  await Promise.race([
    assert.rejects(
      forwardWebhook({
        rawBody: new TextEncoder().encode("{}"),
        headers: { "sentry-hook-signature": "signature" },
      }),
      { name: "TimeoutError" },
    ),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("forwarding did not time out")), 50);
    }),
  ]);
});
