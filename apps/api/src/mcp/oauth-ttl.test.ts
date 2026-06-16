import { strict as assert } from "node:assert";
import { test } from "node:test";

// Importing oauth.ts pulls in @superlog/db, whose client throws at import time
// when DATABASE_URL is unset. postgres-js connects lazily, so a dummy value is
// enough — these tests only read exported constants.
process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";
process.env.BETTER_AUTH_SECRET ??= "test-better-auth-secret";

const { ACCESS_TTL_SECONDS, REFRESH_TTL_SECONDS } = await import("./oauth.js");

const DAY = 60 * 60 * 24;

test("OAuth access tokens live ~1 month", () => {
  assert.equal(ACCESS_TTL_SECONDS, 30 * DAY);
});

test("OAuth refresh tokens outlive access tokens", () => {
  assert.equal(REFRESH_TTL_SECONDS, 90 * DAY);
  assert.ok(REFRESH_TTL_SECONDS > ACCESS_TTL_SECONDS);
});
