import { and, eq, isNull, ne } from "drizzle-orm";
import type { DB } from "./client.js";
import * as schema from "./schema.js";

// Credentials a person holds to act as themselves: browser sessions, CLI
// sessions, personal access tokens, MCP OAuth grants, and the org management
// keys they created. A password reset, password change, or ban ends all of
// them. Workspace integrations (Slack, GitHub, Linear, Sentry, cloud
// connections) and project ingest keys are held by the server on the org's
// behalf and are not tied to one person, so they are left alone.

export type UserCredentialRevocation = {
  sessions: number;
  cliSessions: number;
  personalAccessTokens: number;
  mcpOauthTokens: number;
  mcpOauthCodes: number;
  orgApiKeys: number;
};

export async function revokeUserCredentials(
  database: DB,
  userId: string,
  options: { keepSessionToken?: string | null; now?: Date } = {},
): Promise<UserCredentialRevocation> {
  const now = options.now ?? new Date();
  const keep = options.keepSessionToken;
  return database.transaction(async (tx) => {
    const sessions = await tx
      .delete(schema.sessions)
      .where(
        keep
          ? and(eq(schema.sessions.userId, userId), ne(schema.sessions.token, keep))
          : eq(schema.sessions.userId, userId),
      )
      .returning({ id: schema.sessions.id });
    const cliSessions = await tx
      .update(schema.cliSessions)
      .set({ revokedAt: now })
      .where(and(eq(schema.cliSessions.userId, userId), isNull(schema.cliSessions.revokedAt)))
      .returning({ id: schema.cliSessions.id });
    const personalAccessTokens = await tx
      .update(schema.personalAccessTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(schema.personalAccessTokens.userId, userId),
          isNull(schema.personalAccessTokens.revokedAt),
        ),
      )
      .returning({ id: schema.personalAccessTokens.id });
    // Revoking the row disables both its access and its refresh token.
    const mcpOauthTokens = await tx
      .update(schema.mcpOauthTokens)
      .set({ revokedAt: now })
      .where(and(eq(schema.mcpOauthTokens.userId, userId), isNull(schema.mcpOauthTokens.revokedAt)))
      .returning({ id: schema.mcpOauthTokens.id });
    const mcpOauthCodes = await tx
      .delete(schema.mcpOauthCodes)
      .where(and(eq(schema.mcpOauthCodes.userId, userId), isNull(schema.mcpOauthCodes.usedAt)))
      .returning({ code: schema.mcpOauthCodes.code });
    const orgApiKeys = await tx
      .update(schema.orgApiKeys)
      .set({ revokedAt: now })
      .where(
        and(eq(schema.orgApiKeys.createdByUserId, userId), isNull(schema.orgApiKeys.revokedAt)),
      )
      .returning({ id: schema.orgApiKeys.id });
    return {
      sessions: sessions.length,
      cliSessions: cliSessions.length,
      personalAccessTokens: personalAccessTokens.length,
      mcpOauthTokens: mcpOauthTokens.length,
      mcpOauthCodes: mcpOauthCodes.length,
      orgApiKeys: orgApiKeys.length,
    };
  });
}

// Same rule as Better Auth's admin plugin: a ban holds until `banExpires`
// passes, and forever when it has no expiry.
export function isBanActive(
  user: { banned: boolean | null | undefined; banExpires: Date | string | null | undefined },
  now: Date = new Date(),
): boolean {
  if (!user.banned) return false;
  if (!user.banExpires) return true;
  return new Date(user.banExpires).getTime() > now.getTime();
}

export async function userHasActiveBan(
  database: DB,
  userId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const user = await database.query.users.findFirst({
    where: eq(schema.users.id, userId),
    columns: { banned: true, banExpires: true },
  });
  return user ? isBanActive(user, now) : false;
}
