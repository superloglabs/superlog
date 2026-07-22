import assert from "node:assert/strict";
import { test } from "node:test";
import { startSentryAuthorizationCleanup } from "./authorization-cleanup.js";

test("clears expired Sentry grants when the API starts", async () => {
  const calls: Date[] = [];
  const errors: unknown[] = [];
  const now = new Date("2026-07-22T12:11:00.000Z");
  const stop = startSentryAuthorizationCleanup({
    repository: {
      expireReady: async (requestedAt) => {
        calls.push(requestedAt);
        return 2;
      },
    },
    intervalMs: 60_000,
    now: () => now,
    onError: (error) => errors.push(error),
  });

  await new Promise((resolve) => setImmediate(resolve));
  stop();
  assert.deepEqual(calls, [now]);
  assert.deepEqual(errors, []);
});
