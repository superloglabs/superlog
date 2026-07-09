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
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  type CloudflareInstallationTokens,
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
        columns: { id: true, accountId: true, refreshTokenCiphertext: true },
      });
      return rows.map((row) => ({
        id: row.id,
        accountId: row.accountId,
        hasRefreshToken: row.refreshTokenCiphertext != null,
      }));
    },

    async withLockedInstallation(installationId, fn) {
      return db.transaction(async (tx) => {
        // Same namespaced advisory lock the api's freshAccessToken takes, so an
        // on-demand refresh and this keep-alive can't redeem the same rotating
        // token concurrently. Auto-released at transaction end.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext('cloudflare_installations'), hashtext(${installationId}))`,
        );
        const cur = await tx.query.cloudflareInstallations.findFirst({
          where: and(
            eq(schema.cloudflareInstallations.id, installationId),
            isNull(schema.cloudflareInstallations.revokedAt),
          ),
          columns: {
            refreshTokenCiphertext: true,
            refreshTokenNonce: true,
            refreshTokenKeyVersion: true,
            tokenExpiresAt: true,
          },
        });
        let current: CloudflareInstallationTokens | null = null;
        if (cur != null) {
          let refreshToken: string | null = null;
          if (cur.refreshTokenCiphertext && cur.refreshTokenNonce) {
            try {
              refreshToken = decryptIntegrationSecret({
                ciphertext: cur.refreshTokenCiphertext,
                nonce: cur.refreshTokenNonce,
                keyVersion: cur.refreshTokenKeyVersion ?? 1,
              });
            } catch (err) {
              // A row whose refresh token can't be decrypted (corrupted
              // ciphertext / stale key version) must skip like a no-token
              // install — nothing was rotated, so don't abort the whole pass.
              log.error(
                {
                  installation_id: installationId,
                  err: err instanceof Error ? err.message : String(err),
                },
                "cloudflare refresh token decrypt failed; skipping install",
              );
              refreshToken = null;
            }
          }
          current = { refreshToken, tokenExpiresAt: cur.tokenExpiresAt };
        }

        const save = async (tokens: {
          accessToken: string;
          refreshToken: string | null;
          tokenExpiresAt: Date | null;
        }): Promise<void> => {
          const accessCipher = encryptIntegrationSecret(tokens.accessToken);
          const refreshCipher = tokens.refreshToken
            ? encryptIntegrationSecret(tokens.refreshToken)
            : null;
          await tx
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
            // revokedAt guard: a revoke landing between list and write (uninstall
            // / account-switch) must not resurrect tokens on a torn-down row.
            .where(
              and(
                eq(schema.cloudflareInstallations.id, installationId),
                isNull(schema.cloudflareInstallations.revokedAt),
              ),
            );
        };

        return fn(current, save);
      });
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
