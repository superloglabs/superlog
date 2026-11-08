import assert from "node:assert/strict";
import { test } from "node:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { AUTH_CLIENT_IP_HEADER } from "./auth-client-ip.js";
import { AUTH_RATE_LIMIT } from "./auth-rate-limit.js";

test("email sign-in is limited to five attempts per IP in fifteen minutes", async () => {
  const auth = betterAuth({
    baseURL: "http://localhost:4100",
    secret: "a-very-long-test-only-better-auth-secret",
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    advanced: { ipAddress: { ipAddressHeaders: [AUTH_CLIENT_IP_HEADER] } },
    rateLimit: { ...AUTH_RATE_LIMIT, storage: "memory" },
    emailAndPassword: { enabled: true },
  });
  const request = (ip = "198.51.100.11") =>
    auth.handler(
      new Request("http://localhost:4100/api/auth/sign-in/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [AUTH_CLIENT_IP_HEADER]: ip,
        },
        body: JSON.stringify({ email: "nobody@example.com", password: "invalid-password" }),
      }),
    );

  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.notEqual((await request()).status, 429);
  }

  const limited = await request();
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("x-retry-after")) > 0);
  assert.notEqual((await request("198.51.100.12")).status, 429);
});

test("rate limiting is always enabled and disables unconfigured routes", () => {
  assert.equal(AUTH_RATE_LIMIT.enabled, true);
  // Memory storage avoids better-auth v1.6's concurrent-INSERT race condition
  // on rate_limits_key_idx; the cross-instance global pre-handler limit
  // (auth-rate-limit-repository.ts) handles shared enforcement.
  assert.equal(AUTH_RATE_LIMIT.storage, "memory");
  assert.equal(AUTH_RATE_LIMIT.customRules?.["*"], false);
});

test("signup and account-recovery routes use their dedicated limits", async (t) => {
  const cases = [
    { path: "/sign-up/email", max: 5, ip: "198.51.100.31" },
    { path: "/request-password-reset", max: 3, ip: "198.51.100.32" },
    { path: "/send-verification-email", max: 3, ip: "198.51.100.33" },
  ];

  for (const example of cases) {
    await t.test(example.path, async () => {
      const auth = betterAuth({
        baseURL: "http://localhost:4100",
        secret: "one-more-very-long-test-only-auth-secret",
        database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
        advanced: { ipAddress: { ipAddressHeaders: [AUTH_CLIENT_IP_HEADER] } },
        rateLimit: { ...AUTH_RATE_LIMIT, storage: "memory" },
        emailAndPassword: { enabled: true },
        emailVerification: { sendVerificationEmail: async () => undefined },
      });
      const request = () =>
        auth.handler(
          new Request(`http://localhost:4100/api/auth${example.path}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              [AUTH_CLIENT_IP_HEADER]: example.ip,
            },
            body: "{}",
          }),
        );

      for (let attempt = 0; attempt < example.max; attempt += 1) {
        assert.notEqual((await request()).status, 429);
      }
      assert.equal((await request()).status, 429);
    });
  }
});
