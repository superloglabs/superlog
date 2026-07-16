import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ExpiredGcpAuthorizationTokenStore } from "../gcp/authorization-token-cleaner.js";
import { createGcpAuthorizationCleanupHandler, job } from "./gcp-authorization-cleanup.js";

test("the cleanup job runs every minute and clears grants using its fire time", async () => {
  const now = new Date("2026-07-16T12:00:00.000Z");
  const calls: Date[] = [];
  const store: ExpiredGcpAuthorizationTokenStore = {
    async clearExpiredTokens(at) {
      calls.push(at);
      return 1;
    },
  };

  assert.equal(job.schedule, "* * * * *");
  await createGcpAuthorizationCleanupHandler(store, () => now)();
  assert.deepEqual(calls, [now]);
});
