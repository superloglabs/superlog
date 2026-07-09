// Scheduled job: keep every active Cloudflare installation's OAuth grant alive
// (see ../cloudflare/refresher.ts for the logic + rationale; this file is only
// the wiring — drizzle-backed store, decrypted secrets, env config).
//
// Daily is the right cadence: the refresh token is bounded by the client's
// grant session duration (Cloudflare caps it at one month) and rotates on use,
// so a once-a-day touch keeps it alive with huge margin and negligible cost.
// Opts out (returns null → not scheduled) unless the Cloudflare OAuth client is
// configured, since without it there's nothing to refresh with.

import { cloudflareClientFromEnv } from "@superlog/cloudflare";
import { decryptIntegrationSecret, encryptIntegrationSecret, schema } from "@superlog/db";
import { and, eq, isNull } from "drizzle-orm";
import {
  type CloudflareRefreshInstallation,
  type CloudflareRefresherStore,
  runCloudflareRefreshOnce,
} from "../cloudflare/refresher.js";
import type { JobDefinition, JobDeps } from "../jobs.js";
import { logger } from "../logger.js";

const log = logger.child({ scope: "cloudflare-refresh" });

// Built from JobDeps.db (not the module-level import) so the job follows the
// jobs contract and can run against an injected/test database.
function createStore(db: JobDeps["db"]): CloudflareRefresherStore {
  return {
    async listActiveInstallations(): Promise<CloudflareRefreshInstallation[]> {
      const rows = await db.query.cloudflareInstallations.findMany({
        where: isNull(schema.cloudflareInstallations.revokedAt),
      });
      const installations: CloudflareRefreshInstallation[] = [];
      for (const row of rows) {
        try {
          installations.push({
            id: row.id,
            projectId: row.projectId,
            accountId: row.accountId,
            refreshToken:
              row.refreshTokenCiphertext && row.refreshTokenNonce
                ? decryptIntegrationSecret({
                    ciphertext: row.refreshTokenCiphertext,
                    nonce: row.refreshTokenNonce,
                    keyVersion: row.refreshTokenKeyVersion ?? 1,
                  })
                : null,
          });
        } catch (err) {
          // A row whose refresh token can't be decrypted (e.g. key rotation gone
          // wrong) must not block the other installations.
          log.error(
            { installation_id: row.id, err: err instanceof Error ? err.message : String(err) },
            "cloudflare install secret decrypt failed; skipping",
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
        .update(schema.cloudflareInstallations)
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
        // Guard against a revoke landing between the list and this write (an
        // uninstall / account-switch mid-pass): never rewrite tokens onto a
        // row that's since been torn down.
        .where(
          and(
            eq(schema.cloudflareInstallations.id, id),
            isNull(schema.cloudflareInstallations.revokedAt),
          ),
        );
    },
  };
}

export const job: JobDefinition = {
  name: "cloudflare-refresh",
  // Once a day, 03:00 UTC — off-peak, and far inside the one-month grant window.
  schedule: "0 3 * * *",
  create: (deps) => {
    const config = cloudflareClientFromEnv();
    if (!config) {
      log.info({}, "CLOUDFLARE_CLIENT_ID/SECRET not set — cloudflare refresh job disabled");
      return null;
    }
    const store = createStore(deps.db);
    return async () => {
      const stats = await runCloudflareRefreshOnce({ store, config, log });
      if (stats.refreshed > 0 || stats.errors > 0 || stats.skipped > 0) {
        log.info({ ...stats }, "cloudflare refresh pass complete");
      }
    };
  },
};
