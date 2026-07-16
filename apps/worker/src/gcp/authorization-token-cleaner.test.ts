import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  type ExpiredGcpAuthorizationTokenStore,
  cleanupExpiredGcpAuthorizationTokens,
} from "./authorization-token-cleaner.js";

test("expired Google authorization tokens are cleared without a user revisiting", async () => {
  const now = new Date("2026-07-16T12:00:00.000Z");
  const calls: Date[] = [];
  const store: ExpiredGcpAuthorizationTokenStore = {
    async clearExpiredTokens(at) {
      calls.push(at);
      return 2;
    },
  };

  const cleared = await cleanupExpiredGcpAuthorizationTokens({ store, now });

  assert.equal(cleared, 2);
  assert.deepEqual(calls, [now]);
});
