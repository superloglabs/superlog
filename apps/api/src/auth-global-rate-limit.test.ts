import assert from "node:assert/strict";
import { test } from "node:test";
import {
  enforceAccountSignInRateLimit,
  enforceGlobalAuthRateLimit,
} from "./auth-global-rate-limit.js";

test("the global auth limit uses one per-IP bucket across every auth route", async () => {
  const calls: unknown[] = [];
  const response = await enforceGlobalAuthRateLimit(
    {
      consume: async (input) => {
        calls.push(input);
        return { allowed: false, retryAfterSeconds: 17 };
      },
    },
    "198.51.100.42",
    1_800_000_000_000,
  );

  assert.deepEqual(calls, [
    {
      key: "auth:global:198.51.100.42",
      max: 60,
      windowMs: 60_000,
      nowEpochMs: 1_800_000_000_000,
    },
  ]);
  assert.equal(response?.status, 429);
  assert.equal(response?.headers.get("retry-after"), "17");
});

test("the global auth limit falls through when the request is allowed", async () => {
  const response = await enforceGlobalAuthRateLimit(
    { consume: async () => ({ allowed: true, retryAfterSeconds: null }) },
    undefined,
    1_800_000_000_000,
  );

  assert.equal(response, null);
});

test("email sign-in is also limited per account, across client addresses", async () => {
  const keys: string[] = [];
  const repository = {
    consume: async (input: { key: string; max: number; windowMs: number }) => {
      keys.push(`${input.key}|${input.max}|${input.windowMs}`);
      return { allowed: keys.length < 2, retryAfterSeconds: 600 };
    },
  };
  assert.equal(
    await enforceAccountSignInRateLimit(repository, " Owner@Example.com ", 1_800_000_000_000),
    null,
  );
  const limited = await enforceAccountSignInRateLimit(
    repository,
    "owner@example.com",
    1_800_000_000_000,
  );
  assert.deepEqual(keys, [
    "auth:sign-in:account:owner@example.com|10|900000",
    "auth:sign-in:account:owner@example.com|10|900000",
  ]);
  assert.equal(limited?.status, 429);
  assert.equal(limited?.headers.get("retry-after"), "600");
});

test("a sign-in without an email address is left to Better Auth", async () => {
  const response = await enforceAccountSignInRateLimit(
    {
      consume: async () => {
        throw new Error("should not consume");
      },
    },
    undefined,
  );
  assert.equal(response, null);
});
