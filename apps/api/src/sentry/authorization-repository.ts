import { db, decryptIntegrationSecret, encryptIntegrationSecret, schema } from "@superlog/db";
import { and, eq, gt } from "drizzle-orm";
import type {
  SentryAuthorizationClaim,
  SentryAuthorizationRepository,
  SentryAuthorizationView,
} from "./authorization-session.js";
import { SentryAuthorizationError } from "./authorization-session.js";

type Row = typeof schema.sentryAuthorizationSessions.$inferSelect;

function toView(row: Row): SentryAuthorizationView {
  return {
    id: row.id,
    organizationSlug: row.organizationSlug,
    projects: row.projects,
    expiresAt: row.expiresAt,
  };
}

export class DrizzleSentryAuthorizationRepository implements SentryAuthorizationRepository {
  async create(
    input: Parameters<SentryAuthorizationRepository["create"]>[0],
  ): Promise<SentryAuthorizationView> {
    const access = encryptIntegrationSecret(input.token.accessToken);
    const refresh = encryptIntegrationSecret(input.token.refreshToken);
    const row = await db.transaction(async (tx) => {
      await tx
        .update(schema.sentryAuthorizationSessions)
        .set({
          status: "failed",
          accessTokenCiphertext: null,
          accessTokenNonce: null,
          accessTokenKeyVersion: null,
          refreshTokenCiphertext: null,
          refreshTokenNonce: null,
          refreshTokenKeyVersion: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.sentryAuthorizationSessions.projectId, input.projectId),
            eq(schema.sentryAuthorizationSessions.userId, input.userId),
            eq(schema.sentryAuthorizationSessions.status, "ready"),
          ),
        );
      const [created] = await tx
        .insert(schema.sentryAuthorizationSessions)
        .values({
          projectId: input.projectId,
          userId: input.userId,
          organizationSlug: input.organizationSlug,
          sentryInstallationId: input.sentryInstallationId,
          projects: input.projects,
          accessTokenCiphertext: access.ciphertext,
          accessTokenNonce: access.nonce,
          accessTokenKeyVersion: access.keyVersion,
          refreshTokenCiphertext: refresh.ciphertext,
          refreshTokenNonce: refresh.nonce,
          refreshTokenKeyVersion: refresh.keyVersion,
          oauthExpiresAt: input.token.expiresAt,
          expiresAt: input.expiresAt,
        })
        .returning();
      if (!created) throw new Error("failed to create Sentry authorization session");
      return created;
    });
    return toView(row);
  }

  async findReady(
    input: Parameters<SentryAuthorizationRepository["findReady"]>[0],
  ): Promise<SentryAuthorizationView | null> {
    const row = await db.query.sentryAuthorizationSessions.findFirst({
      where: and(
        eq(schema.sentryAuthorizationSessions.id, input.id),
        eq(schema.sentryAuthorizationSessions.projectId, input.projectId),
        eq(schema.sentryAuthorizationSessions.userId, input.userId),
        eq(schema.sentryAuthorizationSessions.status, "ready"),
        gt(schema.sentryAuthorizationSessions.expiresAt, input.now),
      ),
    });
    return row ? toView(row) : null;
  }

  async claim(
    input: Parameters<SentryAuthorizationRepository["claim"]>[0],
  ): Promise<SentryAuthorizationClaim> {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.sentryAuthorizationSessions)
        .where(eq(schema.sentryAuthorizationSessions.id, input.id))
        .limit(1)
        .for("update");
      if (!row || row.projectId !== input.projectId || row.userId !== input.userId) {
        throw new SentryAuthorizationError("not_found", "Sentry authorization not found");
      }
      if (row.status === "consumed" || row.consumedAt) {
        throw new SentryAuthorizationError("consumed", "Sentry authorization was already used");
      }
      if (row.expiresAt.getTime() <= input.now.getTime()) {
        await clearGrant(tx, row.id, "failed", input.now);
        throw new SentryAuthorizationError("expired", "Sentry authorization expired");
      }
      if (row.status !== "ready") {
        throw new SentryAuthorizationError("unavailable", "Sentry authorization is unavailable");
      }
      const project = row.projects.find((item) => item.slug === input.sentryProjectSlug);
      if (!project) {
        throw new SentryAuthorizationError(
          "invalid_selection",
          "Select a project returned by Sentry",
        );
      }
      if (
        !row.accessTokenCiphertext ||
        !row.accessTokenNonce ||
        !row.accessTokenKeyVersion ||
        !row.refreshTokenCiphertext ||
        !row.refreshTokenNonce ||
        !row.refreshTokenKeyVersion ||
        !row.oauthExpiresAt
      ) {
        throw new SentryAuthorizationError(
          "unavailable",
          "Sentry authorization token is unavailable",
        );
      }
      const token = {
        accessToken: decryptIntegrationSecret({
          ciphertext: row.accessTokenCiphertext,
          nonce: row.accessTokenNonce,
          keyVersion: row.accessTokenKeyVersion,
        }),
        refreshToken: decryptIntegrationSecret({
          ciphertext: row.refreshTokenCiphertext,
          nonce: row.refreshTokenNonce,
          keyVersion: row.refreshTokenKeyVersion,
        }),
        expiresAt: row.oauthExpiresAt,
      };
      await clearGrant(tx, row.id, "consumed", input.now);
      return {
        organizationSlug: row.organizationSlug,
        sentryInstallationId: row.sentryInstallationId,
        project,
        token,
      };
    });
  }
}

async function clearGrant(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  id: string,
  status: "consumed" | "failed",
  now: Date,
): Promise<void> {
  await tx
    .update(schema.sentryAuthorizationSessions)
    .set({
      status,
      consumedAt: status === "consumed" ? now : null,
      accessTokenCiphertext: null,
      accessTokenNonce: null,
      accessTokenKeyVersion: null,
      refreshTokenCiphertext: null,
      refreshTokenNonce: null,
      refreshTokenKeyVersion: null,
      updatedAt: now,
    })
    .where(eq(schema.sentryAuthorizationSessions.id, id));
}
