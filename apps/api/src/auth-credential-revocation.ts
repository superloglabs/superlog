import { db, isBanActive, revokeUserCredentials } from "@superlog/db";
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from "better-auth/api";
import { logger } from "./logger.js";

// A password reset, password change, or ban ends the user's Better Auth
// sessions and revokes the bearer credentials they hold (CLI sessions,
// personal access tokens, MCP OAuth grants, org management keys they created).
// See revokeUserCredentials in @superlog/db for exactly what is revoked.

const log = logger.child({ scope: "auth-credential-revocation" });

async function revoke(
  reason: "password_reset" | "password_change" | "admin_set_password" | "ban",
  userId: string,
  keepSessionToken: string | null = null,
): Promise<void> {
  const revoked = await revokeUserCredentials(db, userId, { keepSessionToken });
  log.info({ userId, reason, revoked }, "revoked user credentials");
}

/** `emailAndPassword.onPasswordReset`: the reset link proves only email access. */
export async function revokeCredentialsOnPasswordReset({
  user,
}: {
  user: { id: string };
}): Promise<void> {
  await revoke("password_reset", user.id);
}

/**
 * `databaseHooks.user.update.after`: covers every route that bans a user
 * (`/admin/ban-user`, `/admin/update-user` with `banned: true`). Revocation is
 * idempotent, so a later update to an already-banned user is harmless.
 */
export async function revokeCredentialsIfBanned(user: {
  id: string;
  banned?: unknown;
  banExpires?: unknown;
}): Promise<void> {
  const ban = {
    banned: user.banned === true,
    banExpires:
      user.banExpires instanceof Date || typeof user.banExpires === "string"
        ? user.banExpires
        : null,
  };
  if (!isBanActive(ban)) return;
  await revoke("ban", user.id);
}

type PasswordChangeTarget = {
  reason: "password_change" | "admin_set_password";
  userId: string;
  keepSessionToken: string | null;
};

/**
 * Decides whom a finished Better Auth request should revoke credentials for.
 * Returns null for other routes and for requests that failed.
 */
export function passwordChangeTarget(input: {
  path: string | undefined;
  body: unknown;
  returned: unknown;
  session: { userId: string; token: string } | null;
}): PasswordChangeTarget | null {
  const { path, body, returned, session } = input;
  if (!returned || typeof returned !== "object") return null;
  if (isAPIError(returned) || returned instanceof Error || returned instanceof Response)
    return null;

  if (path === "/change-password") {
    const result = returned as { token?: unknown; user?: { id?: unknown } };
    const userId = typeof result.user?.id === "string" ? result.user.id : session?.userId;
    if (!userId) return null;
    // With revokeOtherSessions Better Auth replaces the caller's session and
    // returns the new token; otherwise the caller keeps its current session.
    const keepSessionToken =
      typeof result.token === "string" && result.token ? result.token : (session?.token ?? null);
    return { reason: "password_change", userId, keepSessionToken };
  }

  if (path === "/admin/set-user-password") {
    const userId = (body as { userId?: unknown } | null)?.userId;
    if (typeof userId !== "string" || !userId) return null;
    // An admin setting their own password keeps the session they used.
    const keepSessionToken = session?.userId === userId ? session.token : null;
    return { reason: "admin_set_password", userId, keepSessionToken };
  }

  return null;
}

/**
 * The user behind a session Better Auth is about to return, when they are
 * banned. Covers bans written straight to the users table, which skip the
 * ban hook above.
 */
export function bannedSessionUserId(returned: unknown): string | null {
  if (!returned || typeof returned !== "object" || !("user" in returned)) return null;
  const user = (returned as { user?: { id?: unknown; banned?: unknown; banExpires?: unknown } })
    .user;
  if (!user || typeof user.id !== "string") return null;
  const ban = {
    banned: user.banned === true,
    banExpires:
      user.banExpires instanceof Date || typeof user.banExpires === "string"
        ? user.banExpires
        : null,
  };
  return isBanActive(ban) ? user.id : null;
}

/**
 * `hooks.after`: runs after every Better Auth endpoint. A session of a banned
 * user is refused and ended; a finished password change revokes credentials.
 */
export const revokeCredentialsAfterPasswordChange = createAuthMiddleware(async (ctx) => {
  if (ctx.path === "/get-session") {
    const bannedUserId = bannedSessionUserId(ctx.context.returned);
    if (!bannedUserId) return;
    await revoke("ban", bannedUserId);
    return ctx.json(null);
  }
  const current = ctx.context.session;
  const target = passwordChangeTarget({
    path: ctx.path,
    body: ctx.body,
    returned: ctx.context.returned,
    session: current ? { userId: current.user.id, token: current.session.token } : null,
  });
  if (!target) return;
  await revoke(target.reason, target.userId, target.keepSessionToken);
});

/**
 * `hooks.before`: a banned user's session works for no Better Auth endpoint.
 * /get-session answers null instead, in the after hook.
 */
export const refuseBannedSessions = createAuthMiddleware(async (ctx) => {
  if (ctx.path === "/get-session") return;
  const current = await getSessionFromCtx(ctx).catch(() => null);
  const bannedUserId = bannedSessionUserId(current);
  if (!bannedUserId) return;
  await revoke("ban", bannedUserId);
  throw new APIError("UNAUTHORIZED", { message: "This account is banned." });
});
