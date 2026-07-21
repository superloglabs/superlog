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
  refreshIfExpiring(
    installationId: string,
    refreshAt: Date,
    issueToken: (credential: SentryCredential) => Promise<{
      accessToken: string;
      refreshToken: string | null;
      expiresAt: Date | null;
    }>,
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

    async refreshIfExpiring(installationId, refreshAt, issueToken) {
      return database.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(sentryInstallations)
          .where(
            and(eq(sentryInstallations.id, installationId), isNull(sentryInstallations.revokedAt)),
          )
          .for("update");
        if (!row) throw new Error("Sentry installation disappeared during token refresh");
        const current = decryptRow(row);
        if (!current.expiresAt || current.expiresAt.getTime() > refreshAt.getTime()) {
          return current;
        }

        const token = await issueToken(current);
        const access = encryptIntegrationSecret(token.accessToken);
        const refresh = token.refreshToken ? encryptIntegrationSecret(token.refreshToken) : null;
        const rows = await tx
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
        const updated = rows[0];
        if (!updated) throw new Error("Sentry installation disappeared during token refresh");
        return decryptRow(updated);
      });
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
