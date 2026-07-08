// Scheduled job: pull logs + infra metrics from Render for every active
// installation and forward them to our intake (see ../render/puller.ts for
// the pull logic; this file is only the wiring — drizzle-backed store,
// decrypted secrets, env config).
//
// Every minute is the latency floor for Render logs (pg-boss cron is
// minute-granular); metrics are gated inside the puller to one poll per
// installation per ~5 minutes. Opts out (returns null → not scheduled) unless
// AGENT_SECRETS_KEY is set — without it the stored Render API keys can't be
// decrypted, so there is nothing the puller could do.

import { decryptIntegrationSecret, schema } from "@superlog/db";
import { eq, isNull } from "drizzle-orm";
import type { JobDefinition, JobDeps } from "../jobs.js";
import { logger } from "../logger.js";
import {
  type RenderPullerInstallation,
  type RenderPullerStore,
  runRenderPullOnce,
} from "../render/puller.js";

const log = logger.child({ scope: "render-pull" });

function intakeBaseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  if (env.RENDER_INTAKE_URL) return env.RENDER_INTAKE_URL;
  // Local default: the proxy on this machine (portless injects its app port).
  const proxyPort = env.PROXY_APP_PORT ?? "4000";
  return `http://localhost:${proxyPort}`;
}

// Built from JobDeps.db (not the module-level import) so the job follows the
// jobs contract and can run against an injected/test database.
function createStore(db: JobDeps["db"]): RenderPullerStore {
  return {
    async listActiveInstallations(): Promise<RenderPullerInstallation[]> {
      const rows = await db.query.renderInstallations.findMany({
        where: isNull(schema.renderInstallations.revokedAt),
      });
      const installations: RenderPullerInstallation[] = [];
      for (const row of rows) {
        try {
          installations.push({
            id: row.id,
            projectId: row.projectId,
            renderApiKey: decryptIntegrationSecret({
              ciphertext: row.renderApiKeyCiphertext,
              nonce: row.renderApiKeyNonce,
              keyVersion: row.renderApiKeyKeyVersion,
            }),
            ownerId: row.renderOwnerId,
            ownerName: row.renderOwnerName ?? row.renderOwnerId,
            ingestKey:
              row.ingestKeyCiphertext && row.ingestKeyNonce
                ? decryptIntegrationSecret({
                    ciphertext: row.ingestKeyCiphertext,
                    nonce: row.ingestKeyNonce,
                    keyVersion: row.ingestKeyKeyVersion ?? 1,
                  })
                : null,
            services: row.services ?? [],
            logCursor: row.logCursor ?? {},
            metricsCursor: row.metricsCursor ?? {},
          });
        } catch (err) {
          // A row whose secrets can't be decrypted (e.g. key rotation gone
          // wrong) must not block the other installations.
          log.error(
            { installation_id: row.id, err: err instanceof Error ? err.message : String(err) },
            "render install secrets decrypt failed; skipping",
          );
        }
      }
      return installations;
    },

    async saveServices(id, services) {
      await db
        .update(schema.renderInstallations)
        .set({ services, updatedAt: new Date() })
        .where(eq(schema.renderInstallations.id, id));
    },

    async saveCursors(id, cursors) {
      await db
        .update(schema.renderInstallations)
        .set({
          logCursor: cursors.logCursor,
          metricsCursor: cursors.metricsCursor,
          updatedAt: new Date(),
        })
        .where(eq(schema.renderInstallations.id, id));
    },

    // Persistently-rejected key → soft-revoke, mirroring the api's
    // teardownInstallation: the ingest key is revoked too so nothing minted
    // for this install can keep writing.
    async markRevoked(id) {
      const row = await db.query.renderInstallations.findFirst({
        where: eq(schema.renderInstallations.id, id),
      });
      if (row?.apiKeyId) {
        await db
          .update(schema.apiKeys)
          .set({ revokedAt: new Date() })
          .where(eq(schema.apiKeys.id, row.apiKeyId));
      }
      await db
        .update(schema.renderInstallations)
        .set({ revokedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.renderInstallations.id, id));
    },
  };
}

export const job: JobDefinition = {
  name: "render-pull",
  schedule: "* * * * *",
  create: (deps) => {
    if (!process.env.AGENT_SECRETS_KEY) {
      log.info({}, "AGENT_SECRETS_KEY not set — render pull job disabled");
      return null;
    }
    const store = createStore(deps.db);
    const intakeBaseUrl = intakeBaseUrlFromEnv();
    return async () => {
      const stats = await runRenderPullOnce({ store, intakeBaseUrl, log });
      if (stats.installations > 0) {
        log.info({ ...stats }, "render pull pass complete");
      }
    };
  },
};
