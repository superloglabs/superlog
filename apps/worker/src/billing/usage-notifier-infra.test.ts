import assert from "node:assert/strict";
import { test } from "node:test";
import { createResendSend } from "./usage-notifier-infra.js";

type FetchCall = { url: string; body: unknown };

// Build a mock fetch that returns the given sequence of responses. Each entry
// is either a { status } for an HTTP response or null for a network error
// (simulates "fetch failed" / AbortError).
function mockFetch(responses: Array<{ status: number } | null>) {
  const calls: FetchCall[] = [];
  let index = 0;
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
    const spec = responses[index++];
    if (spec === null) throw new TypeError("fetch failed");
    const status = spec.status;
    return { ok: status >= 200 && status < 300, status } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls, attemptCount: () => index };
}

// No-op sleep for tests (avoids real delays).
const noSleep = (_ms: number) => Promise.resolve();

test("createResendSend succeeds on first try", async () => {
  const { impl, calls } = mockFetch([{ status: 200 }]);
  const send = createResendSend("key", impl, noSleep);
  await assert.doesNotReject(send("a@test.com", "Subject", "<p>hi</p>"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.body && (calls[0].body as { to: string[] }).to[0], "a@test.com");
});

test("createResendSend retries on network error and succeeds on second attempt", async () => {
  const { impl, attemptCount } = mockFetch([null, { status: 200 }]);
  const send = createResendSend("key", impl, noSleep);
  await assert.doesNotReject(send("b@test.com", "Subject", "<p>hi</p>"));
  assert.equal(attemptCount(), 2);
});

test("createResendSend retries on 503 and succeeds on third attempt", async () => {
  const { impl, attemptCount } = mockFetch([{ status: 503 }, { status: 500 }, { status: 200 }]);
  const send = createResendSend("key", impl, noSleep);
  await assert.doesNotReject(send("c@test.com", "Subject", "<p>hi</p>"));
  assert.equal(attemptCount(), 3);
});

test("createResendSend throws after all 3 attempts fail with network error", async () => {
  const { impl, attemptCount } = mockFetch([null, null, null]);
  const send = createResendSend("key", impl, noSleep);
  await assert.rejects(send("d@test.com", "Subject", "<p>hi</p>"), /fetch failed/);
  assert.equal(attemptCount(), 3);
});

test("createResendSend throws after all 3 attempts fail with 5xx", async () => {
  const { impl, attemptCount } = mockFetch([{ status: 503 }, { status: 500 }, { status: 502 }]);
  const send = createResendSend("key", impl, noSleep);
  await assert.rejects(send("e@test.com", "Subject", "<p>hi</p>"), /resend -> 502/);
  assert.equal(attemptCount(), 3);
});

test("createResendSend does NOT retry on 4xx (permanent error)", async () => {
  const { impl, attemptCount } = mockFetch([{ status: 422 }, { status: 200 }]);
  const send = createResendSend("key", impl, noSleep);
  await assert.rejects(send("f@test.com", "Subject", "<p>hi</p>"), /resend -> 422/);
  // Only one attempt — 4xx is not retried.
  assert.equal(attemptCount(), 1);
});

test("createResendSend does NOT retry on 401 (bad API key)", async () => {
  const { impl, attemptCount } = mockFetch([{ status: 401 }, { status: 200 }]);
  const send = createResendSend("key", impl, noSleep);
  await assert.rejects(send("g@test.com", "Subject", "<p>hi</p>"), /resend -> 401/);
  assert.equal(attemptCount(), 1);
});
