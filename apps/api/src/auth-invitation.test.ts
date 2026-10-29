import assert from "node:assert/strict";
import { test } from "node:test";

// auth.ts throws at import if BETTER_AUTH_SECRET is unset, and @superlog/db
// needs DATABASE_URL (the postgres client connects lazily, so a dummy is
// enough). Mirror the other auth-adjacent tests and provide both before import.
process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";
process.env.BETTER_AUTH_SECRET ??= "test-better-auth-secret";

test("organization plugin gates invitations on email verification", async () => {
  const { auth } = await import("./auth.js");
  const plugins = auth.options.plugins as Array<{ id: string; options?: Record<string, unknown> }>;
  const orgPlugin = plugins.find((p) => p.id === "organization");
  assert.ok(orgPlugin, "organization plugin should be registered");

  // B-01: the invitation `id` in the emailed URL must not be the sole proof of
  // mailbox ownership. Keep the Better Auth default (true) so getInvitation /
  // acceptInvitation / rejectInvitation reject unverified sessions with
  // FORBIDDEN — the web accept page maps that to an explicit "verify your
  // email first" state instead of "Invitation not found".
  assert.equal(orgPlugin.options?.requireEmailVerificationOnInvitation, true);
});

test("email+password sign-ups require verification", async () => {
  const { auth } = await import("./auth.js");
  const emailAndPassword = auth.options.emailAndPassword as
    | { requireEmailVerification?: unknown }
    | undefined;
  // Pairs with the organization flag above and the session-middleware gate in
  // index.ts: unverified sessions can only reach GET /api/me + the
  // verify/resend endpoints until they confirm.
  assert.equal(emailAndPassword?.requireEmailVerification, true);
});
