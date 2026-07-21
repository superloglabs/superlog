import { and, eq, isNull } from "drizzle-orm";
import { type DB, db as defaultDb } from "./client.js";
import { decryptIntegrationSecret, encryptIntegrationSecret } from "./integration-secrets.js";
import { sentryInstallations } from "./schema.js";

export type SentryCredential = {
  id: string;
  sentryInstallationId: string;
  organizationSlug: string;
  projectSlug: string;
  accessToken: string;
  refreshToken: string | null;
  relayToken: string;
  expiresAt: Date | null;
};

export type SentryCredentialRepository = {
  getActive(projectId: string): Promise<SentryCredential | null>;
  updateToken(
    installationId: string,
    token: { accessToken: string; refreshToken: string | null; expiresAt: Date | null },
  ): Promise<SentryCredential>;
  markNeedsReauth(installationId: string, reason: string): Promise<void>;
};

export function createSentryCredentialRepository(
  database: DB = defaultDb,
): SentryCredentialRepository {
  return {
    async getActive(projectId) {
      const row = await database.query.sentryInstallations.findFirst({
        where: and(
          eq(sentryInstallations.projectId, projectId),
          isNull(sentryInstallations.revokedAt),
        ),
      });
      return row ? decryptRow(row) : null;
    },

    async updateToken(installationId, token) {
      const access = encryptIntegrationSecret(token.accessToken);
      const refresh = token.refreshToken ? encryptIntegrationSecret(token.refreshToken) : null;
      const rows = await database
        .update(sentryInstallations)
        .set({
          accessTokenCiphertext: access.ciphertext,
          accessTokenNonce: access.nonce.toString("base64"),
          accessTokenKeyVersion: access.keyVersion,
          refreshTokenCiphertext: refresh?.ciphertext ?? null,
          refreshTokenNonce: refresh?.nonce.toString("base64") ?? null,
          refreshTokenKeyVersion: refresh?.keyVersion ?? null,
          oauthExpiresAt: token.expiresAt,
          reauthRequiredAt: null,
          reauthReason: null,
          updatedAt: new Date(),
        })
        .where(eq(sentryInstallations.id, installationId))
        .returning();
      const row = rows[0];
      if (!row) throw new Error("Sentry installation disappeared during token refresh");
      return decryptRow(row);
    },

    async markNeedsReauth(installationId, reason) {
      await database
        .update(sentryInstallations)
        .set({
          reauthRequiredAt: new Date(),
          reauthReason: reason.slice(0, 1_000),
          updatedAt: new Date(),
        })
        .where(eq(sentryInstallations.id, installationId));
    },
  };
}

function decryptRow(row: typeof sentryInstallations.$inferSelect): SentryCredential {
  return {
    id: row.id,
    sentryInstallationId: row.sentryInstallationId,
    organizationSlug: row.organizationSlug,
    projectSlug: row.sentryProjectSlug,
    accessToken: decryptIntegrationSecret({
      ciphertext: row.accessTokenCiphertext,
      nonce: Buffer.from(row.accessTokenNonce, "base64"),
      keyVersion: row.accessTokenKeyVersion,
    }),
    refreshToken:
      row.refreshTokenCiphertext && row.refreshTokenNonce && row.refreshTokenKeyVersion
        ? decryptIntegrationSecret({
            ciphertext: row.refreshTokenCiphertext,
            nonce: Buffer.from(row.refreshTokenNonce, "base64"),
            keyVersion: row.refreshTokenKeyVersion,
          })
        : null,
    relayToken: decryptIntegrationSecret({
      ciphertext: row.relayTokenCiphertext,
      nonce: Buffer.from(row.relayTokenNonce, "base64"),
      keyVersion: row.relayTokenKeyVersion,
    }),
    expiresAt: row.oauthExpiresAt,
  };
}
