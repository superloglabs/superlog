import * as schema from "@superlog/db/schema";
import { and, eq, lte } from "drizzle-orm";
import {
  type ExpiredGcpAuthorizationTokenStore,
  cleanupExpiredGcpAuthorizationTokens,
} from "../gcp/authorization-token-cleaner.js";
import type { JobDefinition, JobDeps, JobHandler } from "../jobs.js";
import { logger } from "../logger.js";

const log = logger.child({ scope: "gcp-authorization-cleanup" });

function createStore(db: JobDeps["db"]): ExpiredGcpAuthorizationTokenStore {
  return {
    async clearExpiredTokens(now) {
      const rows = await db
        .update(schema.gcpAuthorizationSessions)
        .set({
          status: "failed",
          accessTokenCiphertext: null,
          accessTokenNonce: null,
          accessTokenKeyVersion: null,
          lastError: "Google OAuth authorization expired",
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.gcpAuthorizationSessions.status, "ready"),
            lte(schema.gcpAuthorizationSessions.expiresAt, now),
          ),
        )
        .returning({ id: schema.gcpAuthorizationSessions.id });
      return rows.length;
    },
  };
}

export function createGcpAuthorizationCleanupHandler(
  store: ExpiredGcpAuthorizationTokenStore,
  now: () => Date = () => new Date(),
): JobHandler {
  return async () => {
    const cleared = await cleanupExpiredGcpAuthorizationTokens({ store, now: now() });
    if (cleared > 0) log.info({ cleared }, "expired GCP authorization tokens cleared");
  };
}

export const job: JobDefinition = {
  name: "gcp-authorization-cleanup",
  schedule: "* * * * *",
  create: (deps) => createGcpAuthorizationCleanupHandler(createStore(deps.db)),
};
