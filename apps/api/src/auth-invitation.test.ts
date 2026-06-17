import assert from "node:assert/strict";
import { test } from "node:test";

// auth.ts throws at import if BETTER_AUTH_SECRET is unset, and @superlog/db
// needs DATABASE_URL (the postgres client connects lazily, so a dummy is
// enough). Mirror the other auth-adjacent tests and provide both before import.
process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";
process.env.BETTER_AUTH_SECRET ??= "test-better-auth-secret";

test("organization plugin does not gate invitations on email verification", async () => {
  const { auth } = await import("./auth.js");
  const plugins = auth.options.plugins as Array<{ id: string; options?: Record<string, unknown> }>;
  const orgPlugin = plugins.find((p) => p.id === "organization");
  assert.ok(orgPlugin, "organization plugin should be registered");

  // Better Auth defaults requireEmailVerificationOnInvitation to `true`. That
  // contradicts emailAndPassword.requireEmailVerification:false — sign-ups land
  // logged-in but unverified (the default state), and the default would lock
  // those users out of getInvitation/acceptInvitation with a FORBIDDEN that the
  // UI renders as a misleading "Invitation not found" (looks like a 404). Pin it
  // false so the invite flow matches the app's "verification is optional" stance.
  assert.equal(orgPlugin.options?.requireEmailVerificationOnInvitation, false);
});
