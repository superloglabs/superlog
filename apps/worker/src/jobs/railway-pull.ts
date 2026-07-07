// Scheduled job: pull logs + infra metrics from Railway for every active
// installation and forward them to our intake (see ../railway/puller.ts for
// the pull logic; this file is only the wiring — drizzle-backed store,
// decrypted secrets, env config).
//
// Every minute is the latency floor for Railway logs (pg-boss cron is
// minute-granular); metrics are gated inside the puller to one poll per
// service per ~5 minutes. Opts out (returns null → not scheduled) unless the
// Railway OAuth client is configured — without it tokens can't be refreshed,
// so pulling would strand within the hour anyway.

import { db, decryptIntegrationSecret, encryptIntegrationSecret, schema } from "@superlog/db";
import { railwayConfigFromEnv } from "@superlog/railway";
import { eq, isNull } from "drizzle-orm";
import type { JobDefinition } from "../jobs.js";
import { logger } from "../logger.js";
import {
  type RailwayPullerInstallation,
  type RailwayPullerStore,
  runRailwayPullOnce,
} from "../railway/puller.js";

const log = logger.child({ scope: "railway-pull" });

function intakeBaseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  if (env.RAILWAY_INTAKE_URL) return env.RAILWAY_INTAKE_URL;
  // Local default: the proxy on this machine (portless injects its app port).
  const proxyPort = env.PROXY_APP_PORT ?? "4000";
  return `http://localhost:${proxyPort}`;
}

const store: RailwayPullerStore = {
  async listActiveInstallations(): Promise<RailwayPullerInstallation[]> {
    const rows = await db.query.railwayInstallations.findMany({
      where: isNull(schema.railwayInstallations.revokedAt),
    });
    const installations: RailwayPullerInstallation[] = [];
    for (const row of rows) {
      try {
        installations.push({
          id: row.id,
          projectId: row.projectId,
          accessToken: decryptIntegrationSecret({
            ciphertext: row.accessTokenCiphertext,
            nonce: row.accessTokenNonce,
            keyVersion: row.accessTokenKeyVersion,
          }),
          refreshToken:
            row.refreshTokenCiphertext && row.refreshTokenNonce
              ? decryptIntegrationSecret({
                  ciphertext: row.refreshTokenCiphertext,
                  nonce: row.refreshTokenNonce,
                  keyVersion: row.refreshTokenKeyVersion ?? 1,
                })
              : null,
          tokenExpiresAt: row.tokenExpiresAt,
          ingestKey:
            row.ingestKeyCiphertext && row.ingestKeyNonce
              ? decryptIntegrationSecret({
                  ciphertext: row.ingestKeyCiphertext,
                  nonce: row.ingestKeyNonce,
                  keyVersion: row.ingestKeyKeyVersion ?? 1,
                })
              : null,
          grantedProjects: row.grantedProjects ?? [],
          logCursor: row.logCursor ?? {},
          metricsCursor: row.metricsCursor ?? {},
        });
      } catch (err) {
        // A row whose secrets can't be decrypted (e.g. key rotation gone
        // wrong) must not block the other installations.
        log.error(
          { installation_id: row.id, err: err instanceof Error ? err.message : String(err) },
          "railway install secrets decrypt failed; skipping",
        );
      }
    }
    return installations;
  },

  async saveTokens(id, tokens) {
    const accessCipher = encryptIntegrationSecret(tokens.accessToken);
    const refreshCipher = tokens.refreshToken
      ? encryptIntegrationSecret(tokens.refreshToken)
      : null;
    await db
      .update(schema.railwayInstallations)
      .set({
        accessTokenCiphertext: accessCipher.ciphertext,
        accessTokenNonce: accessCipher.nonce,
        accessTokenKeyVersion: accessCipher.keyVersion,
        refreshTokenCiphertext: refreshCipher?.ciphertext ?? null,
        refreshTokenNonce: refreshCipher?.nonce ?? null,
        refreshTokenKeyVersion: refreshCipher?.keyVersion ?? null,
        tokenExpiresAt: tokens.tokenExpiresAt,
        updatedAt: new Date(),
      })
      .where(eq(schema.railwayInstallations.id, id));
  },

  async saveGrantedProjects(id, projects) {
    await db
      .update(schema.railwayInstallations)
      .set({ grantedProjects: projects, updatedAt: new Date() })
      .where(eq(schema.railwayInstallations.id, id));
  },

  async saveCursors(id, cursors) {
    await db
      .update(schema.railwayInstallations)
      .set({
        logCursor: cursors.logCursor,
        metricsCursor: cursors.metricsCursor,
        updatedAt: new Date(),
      })
      .where(eq(schema.railwayInstallations.id, id));
  },
};

export const job: JobDefinition = {
  name: "railway-pull",
  schedule: "* * * * *",
  create: () => {
    const config = railwayConfigFromEnv();
    if (!config) {
      log.info({}, "RAILWAY_CLIENT_ID/SECRET not set — railway pull job disabled");
      return null;
    }
    const intakeBaseUrl = intakeBaseUrlFromEnv();
    return async () => {
      const stats = await runRailwayPullOnce({ store, config, intakeBaseUrl, log });
      if (stats.installations > 0) {
        log.info({ ...stats }, "railway pull pass complete");
      }
    };
  },
};
