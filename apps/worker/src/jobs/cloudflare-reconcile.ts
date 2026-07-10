// Scheduled job: keep every auto-wire Cloudflare installation's Workers wired to
// our telemetry destinations (see ../cloudflare/reconciler.ts for the logic +
// rationale; this file is only the wiring — drizzle-backed store, decrypted
// secrets, on-demand token refresh under the shared advisory lock).
//
// Hourly: the cadence is the max data-loss window for a Worker that was created,
// recreated, or renamed after connect (it comes up unwired and Cloudflare doesn't
// backfill the dark period), so this runs much tighter than the daily token
// keep-alive. Opts out (returns null → not scheduled) unless the Cloudflare OAuth
// client is configured — without it there's nothing to refresh a token with.

import {
  type CloudflareClientCredentials,
  cloudflareClientFromEnv,
  reconcileWorkerWiring,
  refreshAccessToken,
} from "@superlog/cloudflare";
import { decryptIntegrationSecret, encryptIntegrationSecret, schema } from "@superlog/db";
import { and, eq, isNull } from "drizzle-orm";
import { lockInstallation } from "../cloudflare/lock.js";
import {
  type CloudflareReconcileInstallation,
  type CloudflareReconcilerStore,
  runCloudflareReconcileOnce,
} from "../cloudflare/reconciler.js";
import type { JobDefinition, JobDeps } from "../jobs.js";
import { logger } from "../logger.js";

const log = logger.child({ scope: "cloudflare-reconcile" });

// Refresh the access token when it's within this margin of expiry. Wider than
// the keep-alive's 60s because a reconcile then makes a burst of Cloudflare calls
// with the token, so it must stay valid for the whole pass.
const ACCESS_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

function createStore(
  db: JobDeps["db"],
  config: CloudflareClientCredentials,
  fetchImpl: typeof fetch,
): CloudflareReconcilerStore {
  return {
    async listAutoWireInstallations(): Promise<CloudflareReconcileInstallation[]> {
      const rows = await db.query.cloudflareInstallations.findMany({
        where: and(
          isNull(schema.cloudflareInstallations.revokedAt),
          eq(schema.cloudflareInstallations.autoWire, true),
        ),
        columns: { id: true, accountId: true, destinations: true },
      });
      return rows.map((row) => ({
        id: row.id,
        accountId: row.accountId,
        slugs: { traces: row.destinations?.traces, logs: row.destinations?.logs },
      }));
    },

    async freshAccessToken(installationId): Promise<string | null> {
      return db.transaction(async (tx) => {
        // Same lock the api's freshAccessToken and the keep-alive take, so a
        // rotating refresh token is never redeemed twice concurrently. Held only
        // across the redemption; the wiring calls run after the lock releases.
        await lockInstallation(tx, installationId);
        const cur = await tx.query.cloudflareInstallations.findFirst({
          where: and(
            eq(schema.cloudflareInstallations.id, installationId),
            isNull(schema.cloudflareInstallations.revokedAt),
          ),
          columns: {
            accessTokenCiphertext: true,
            accessTokenNonce: true,
            accessTokenKeyVersion: true,
            refreshTokenCiphertext: true,
            refreshTokenNonce: true,
            refreshTokenKeyVersion: true,
            tokenExpiresAt: true,
          },
        });
        if (!cur) return null; // revoked between list and lock

        let accessToken: string;
        try {
          accessToken = decryptIntegrationSecret({
            ciphertext: cur.accessTokenCiphertext,
            nonce: cur.accessTokenNonce,
            keyVersion: cur.accessTokenKeyVersion,
          });
        } catch (err) {
          // Undecryptable access token (corrupt ciphertext / stale key) → skip
          // this install like a dead grant; nothing was rotated.
          log.error(
            {
              installation_id: installationId,
              err: err instanceof Error ? err.message : String(err),
            },
            "cloudflare reconcile: access token decrypt failed; skipping install",
          );
          return null;
        }

        // Still comfortably valid → use it as-is (no redemption).
        const expiresAt = cur.tokenExpiresAt?.getTime() ?? null;
        if (expiresAt !== null && expiresAt - Date.now() > ACCESS_TOKEN_REFRESH_MARGIN_MS) {
          return accessToken;
        }

        // Near/at expiry → need the refresh token to mint a new one.
        let refreshToken: string | null = null;
        if (cur.refreshTokenCiphertext && cur.refreshTokenNonce) {
          try {
            refreshToken = decryptIntegrationSecret({
              ciphertext: cur.refreshTokenCiphertext,
              nonce: cur.refreshTokenNonce,
              keyVersion: cur.refreshTokenKeyVersion ?? 1,
            });
          } catch {
            refreshToken = null;
          }
        }
        // No refresh token (legacy install) and the access token is stale → this
        // install can't be kept alive; it needs a manual reconnect. Skip.
        if (!refreshToken) return null;

        let refreshed: Awaited<ReturnType<typeof refreshAccessToken>>;
        try {
          refreshed = await refreshAccessToken({ config, refreshToken, fetchImpl });
        } catch (err) {
          // A thrown fetch (network/DNS) didn't persist a rotation — isolate the
          // install (skip) rather than aborting the whole pass.
          log.error(
            {
              installation_id: installationId,
              err: err instanceof Error ? err.message : String(err),
            },
            "cloudflare reconcile: token request threw; skipping install",
          );
          return null;
        }
        if (!refreshed.ok) {
          // Dead grant (expired / revoked) → needs manual reconnect. Skip.
          log.error(
            { installation_id: installationId, error: refreshed.error },
            "cloudflare reconcile: token refresh failed; skipping install",
          );
          return null;
        }

        // Refresh succeeded → the old token is consumed; persisting the
        // replacement is mandatory. A throw here propagates out of the
        // transaction and aborts the pass (reconciler treats it as fatal).
        const accessCipher = encryptIntegrationSecret(refreshed.accessToken);
        const refreshCipher = encryptIntegrationSecret(refreshed.refreshToken ?? refreshToken);
        await tx
          .update(schema.cloudflareInstallations)
          .set({
            accessTokenCiphertext: accessCipher.ciphertext,
            accessTokenNonce: accessCipher.nonce,
            accessTokenKeyVersion: accessCipher.keyVersion,
            refreshTokenCiphertext: refreshCipher.ciphertext,
            refreshTokenNonce: refreshCipher.nonce,
            refreshTokenKeyVersion: refreshCipher.keyVersion,
            tokenExpiresAt:
              refreshed.expiresIn != null
                ? new Date(Date.now() + refreshed.expiresIn * 1000)
                : null,
            updatedAt: new Date(),
          })
          // revokedAt guard: an uninstall/account-switch landing between read and
          // write must not resurrect tokens on a torn-down row.
          .where(
            and(
              eq(schema.cloudflareInstallations.id, installationId),
              isNull(schema.cloudflareInstallations.revokedAt),
            ),
          );
        return refreshed.accessToken;
      });
    },
  };
}

export const job: JobDefinition = {
  name: "cloudflare-reconcile",
  // Hourly on the hour — tight enough that a newly-unwired Worker is dark for at
  // most ~an hour, cheap enough (mostly reads; PATCH only the drifted Workers).
  schedule: "0 * * * *",
  create: (deps) => {
    const config = cloudflareClientFromEnv();
    if (!config) {
      log.info({}, "CLOUDFLARE_CLIENT_ID/SECRET not set — cloudflare reconcile job disabled");
      return null;
    }
    const store = createStore(deps.db, config, fetch);
    return async () => {
      const stats = await runCloudflareReconcileOnce({
        store,
        reconcile: reconcileWorkerWiring,
        log,
      });
      if (stats.reconciled > 0 || stats.errors > 0 || stats.skipped > 0) {
        log.info({ ...stats }, "cloudflare reconcile pass complete");
      }
    };
  },
};
