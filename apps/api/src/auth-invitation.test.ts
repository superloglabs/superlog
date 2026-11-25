import assert from "node:assert/strict";
import { test } from "node:test";

// auth.ts throws at import if BETTER_AUTH_SECRET is unset, and @superlog/db
// needs DATABASE_URL (the postgres client connects lazily, so a dummy is
// enough). Mirror the other auth-adjacent tests and provide both before import.
process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";
process.env.BETTER_AUTH_SECRET ??= "test-better-auth-secret";

test("organization plugin gates invitations on a verified email", async () => {
  const { auth } = await import("./auth.js");
  const plugins = auth.options.plugins as Array<{ id: string; options?: Record<string, unknown> }>;
  const orgPlugin = plugins.find((p) => p.id === "organization");
  assert.ok(orgPlugin, "organization plugin should be registered");

  // Email sign-up never proves the address, so an account made for someone
  // else's email must not be able to view or accept that person's invitations.
  // The accept page offers to send the confirmation email instead.
  assert.equal(orgPlugin.options?.requireEmailVerificationOnInvitation, true);
});
