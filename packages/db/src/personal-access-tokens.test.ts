import { strict as assert } from "node:assert";
import { test } from "node:test";

// These pure helpers don't touch the db client, but importing the module pulls
// in ./client.js transitively, which throws at import time without a connection
// string. postgres-js connects lazily, so a dummy value is enough.
process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";

const { resolvePatExpiry, isPatExpiryChoice } = await import("./personal-access-tokens.js");
const { generatePersonalAccessToken, isPersonalAccessToken, PERSONAL_ACCESS_TOKEN_PREFIX } =
  await import("./keys.js");

test("resolvePatExpiry returns null for never", () => {
  assert.equal(resolvePatExpiry("never"), null);
});

test("resolvePatExpiry adds the right number of days", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  assert.equal(resolvePatExpiry("30d", now)?.toISOString(), "2026-01-31T00:00:00.000Z");
  assert.equal(resolvePatExpiry("90d", now)?.toISOString(), "2026-04-01T00:00:00.000Z");
});

test("isPatExpiryChoice accepts only the three known choices", () => {
  assert.equal(isPatExpiryChoice("never"), true);
  assert.equal(isPatExpiryChoice("30d"), true);
  assert.equal(isPatExpiryChoice("90d"), true);
  assert.equal(isPatExpiryChoice("1y"), false);
  assert.equal(isPatExpiryChoice(undefined), false);
  assert.equal(isPatExpiryChoice(30), false);
});

test("generated personal access tokens carry the pat prefix and are recognizable", () => {
  const key = generatePersonalAccessToken();
  assert.ok(key.plaintext.startsWith(PERSONAL_ACCESS_TOKEN_PREFIX));
  assert.equal(isPersonalAccessToken(key.plaintext), true);
  assert.equal(isPersonalAccessToken("superlog_mcp_at_abc"), false);
  // The stored prefix is a non-secret display fragment, not the whole token.
  assert.ok(key.plaintext.length > key.prefix.length);
});
