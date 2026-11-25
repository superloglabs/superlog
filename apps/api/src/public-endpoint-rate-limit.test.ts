import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import type { AuthRateLimitConsumeInput } from "./auth-global-rate-limit.js";
import { publicEndpointLimits, publicEndpointRateLimit } from "./public-endpoint-rate-limit.js";

function countingRepository() {
  const counts = new Map<string, number>();
  const calls: AuthRateLimitConsumeInput[] = [];
  return {
    calls,
    consume: async (input: AuthRateLimitConsumeInput) => {
      calls.push(input);
      const count = (counts.get(input.key) ?? 0) + 1;
      counts.set(input.key, count);
      return count > input.max
        ? { allowed: false, retryAfterSeconds: 42 }
        : { allowed: true, retryAfterSeconds: null };
    },
  };
}

test("a public endpoint allows a few requests per address, then answers 429", async () => {
  const repository = countingRepository();
  const app = new Hono();
  let address = "198.51.100.1";
  app.post(
    "/oauth/register",
    publicEndpointRateLimit(
      repository,
      { key: "oauth-register", max: 2, windowMs: 60_000 },
      () => address,
    ),
    (c) => c.json({ ok: true }),
  );

  assert.equal((await app.request("/oauth/register", { method: "POST" })).status, 200);
  assert.equal((await app.request("/oauth/register", { method: "POST" })).status, 200);
  const refused = await app.request("/oauth/register", { method: "POST" });
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get("retry-after"), "42");

  address = "198.51.100.2";
  assert.equal((await app.request("/oauth/register", { method: "POST" })).status, 200);
  assert.deepEqual(repository.calls[0], {
    key: "public:oauth-register:198.51.100.1",
    max: 2,
    nowEpochMs: repository.calls[0]?.nowEpochMs,
    windowMs: 60_000,
  });
});

test("unauthenticated endpoints that store something have limits", () => {
  assert.ok(publicEndpointLimits.oauthRegister.max <= 20);
  assert.ok(publicEndpointLimits.oauthDevice.max <= 60);
  assert.ok(publicEndpointLimits.signupIntents.max <= 60);
});
