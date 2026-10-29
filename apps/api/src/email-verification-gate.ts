import { db, schema } from "@superlog/db";
import { and, eq, lt } from "drizzle-orm";

// Email-verification enforcement (B-01 fix). A session whose address is not
// verified may only reach the verification-completion surface (GET /api/me so
// the client can render state + the verify banner; the actual verify/resend
// endpoints live under /api/auth/*, which bypasses the session middleware).
// All other /api/* routes require a verified address, closing the
// invite-accept + full-API-access path for unverified accounts.
//
// Grandfathering: memberships created before the cutoff keep working without
// verification so the rollout doesn't lock out pre-existing unverified users.
// Set EMAIL_VERIFICATION_GRANDFATHER_CUTOFF_ISO to the production deploy time;
// anyone who joins after it must verify. The DB check only runs for
// unverified sessions, so verified traffic pays no extra query.
export const EMAIL_VERIFICATION_GRANDFATHER_CUTOFF = new Date(
  process.env.EMAIL_VERIFICATION_GRANDFATHER_CUTOFF_ISO ?? "2026-09-18T00:00:00.000Z",
);

let cutoffWarningLogged = false;

// Warn once when the deployment cutoff env var is unset: the built-in
// default only fits the initial rollout — production must set
// EMAIL_VERIFICATION_GRANDFATHER_CUTOFF_ISO to its deploy time, otherwise
// memberships created between the default and the real deploy are wrongly
// grandfathered. Called from API boot; injectable log fn for tests.
export function warnIfDefaultGrandfatherCutoff(
  log: (message: string) => void = console.warn,
): void {
  if (cutoffWarningLogged || process.env.EMAIL_VERIFICATION_GRANDFATHER_CUTOFF_ISO) return;
  cutoffWarningLogged = true;
  log(
    `[auth] EMAIL_VERIFICATION_GRANDFATHER_CUTOFF_ISO is unset; ` +
      `grandfathering unverified memberships created before ${EMAIL_VERIFICATION_GRANDFATHER_CUTOFF.toISOString()}. ` +
      `Set it to the production deploy time.`,
  );
}

export const EMAIL_VERIFICATION_ALLOWLIST = new Set(["GET /api/me"]);

export function isEmailVerificationExempt(method: string, path: string): boolean {
  return EMAIL_VERIFICATION_ALLOWLIST.has(`${method} ${path}`);
}

// Better-Auth organization/admin mutations that an unverified,
// non-grandfathered session must not reach. /api/auth/* bypasses the session
// middleware above, so without this an unverified pre-deploy session could
// still create orgs, send invites, or manage members/roles (the invite
// accept/reject endpoints re-gate on verification inside Better-Auth itself,
// and reads stay available — only mutations are denied here).
//
// Deliberately a blocklist, not default-deny: Better-Auth serves internal
// flows (callbacks, session refresh, OAuth token exchange) under /api/auth/*
// that must keep working, and an explicit list keeps the denied surface
// reviewable. The unit test pins the FULL set below, so any removal or
// addition fails loudly until the test is updated alongside it.
export const BLOCKED_AUTH_MUTATIONS = new Set([
  "/api/auth/organization/create",
  "/api/auth/organization/update",
  "/api/auth/organization/delete",
  "/api/auth/organization/invite-member",
  "/api/auth/organization/cancel-invitation",
  "/api/auth/organization/remove-member",
  "/api/auth/organization/update-member-role",
  "/api/auth/organization/leave",
  "/api/auth/organization/create-team",
  "/api/auth/organization/update-team",
  "/api/auth/organization/remove-team",
  "/api/auth/organization/add-team-member",
  "/api/auth/organization/remove-team-member",
  "/api/auth/organization/set-active-team",
  // Review round 2: password changes and org switching are also authenticated
  // mutations. An unverified session has no business doing either (there is
  // no verified mailbox to recover, and unverified users hold no usable org
  // context). Invitation accept/reject stay off this list: Better-Auth
  // re-gates those on verification itself and returns its mapped errors.
  "/api/auth/organization/set-active",
  "/api/auth/change-password",
  "/api/auth/organization/create-role",
  "/api/auth/organization/update-role",
  "/api/auth/organization/delete-role",
  "/api/auth/update-user",
  "/api/auth/change-email",
  "/api/auth/delete-user",
  "/api/auth/admin/impersonate-user",
  "/api/auth/admin/ban-user",
  "/api/auth/admin/unban-user",
  "/api/auth/admin/set-role",
  "/api/auth/admin/remove-user",
]);

export function isAuthMutationBlockedForUnverified(path: string): boolean {
  return BLOCKED_AUTH_MUTATIONS.has(path);
}

export async function isGrandfatheredUnverifiedUser(userId: string): Promise<boolean> {
  const legacyMembership = await db.query.orgMembers.findFirst({
    where: and(
      eq(schema.orgMembers.userId, userId),
      lt(schema.orgMembers.createdAt, EMAIL_VERIFICATION_GRANDFATHER_CUTOFF),
    ),
    columns: { id: true },
  });
  return !!legacyMembership;
}
