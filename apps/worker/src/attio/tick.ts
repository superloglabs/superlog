import type { ClickHouseClient } from "@clickhouse/client";
import type { DB } from "@superlog/db";
import { logger } from "../logger.js";
import { createAttioRestClient } from "./client.js";
import { resolveAttioSyncIntervalMs } from "./config.js";
import { createAttioRepository } from "./repository.js";
import { syncAttio } from "./sync.js";

export type AttioSyncTicker = () => Promise<number>;

export function createAttioSyncTicker(options: {
  db: DB;
  clickhouse: Pick<ClickHouseClient, "query">;
  apiKey?: string | null;
  apiBase?: string;
  enabled?: boolean;
  intervalMs?: number;
  now?: () => number;
}): AttioSyncTicker | null {
  const enabled = options.enabled ?? process.env.ATTIO_SYNC_ENABLED === "true";
  const apiKey = (options.apiKey ?? process.env.ATTIO_API_KEY)?.trim();
  if (!enabled || !apiKey) return null;

  const intervalMs = resolveAttioSyncIntervalMs(
    options.intervalMs ?? process.env.ATTIO_SYNC_INTERVAL_MS,
  );
  const now = options.now ?? Date.now;
  let nextRunAt = 0;
  let running = false;

  const repository = createAttioRepository({ db: options.db, clickhouse: options.clickhouse });
  const client = createAttioRestClient({
    apiKey,
    apiBase: options.apiBase ?? process.env.ATTIO_API_BASE,
  });

  return async () => {
    const current = now();
    if (running || current < nextRunAt) return 0;
    running = true;
    nextRunAt = current + intervalMs;
    try {
      const result = await syncAttio({ repository, client });
      logger.info(
        {
          scope: "attio.sync",
          companiesUpdated: result.companiesUpdated,
          companiesCreated: result.companiesCreated,
          peopleUpserted: result.peopleUpserted,
          companyTeamsUpdated: result.companyTeamsUpdated,
          errors: result.errors.length,
          totals: result.totals,
        },
        "attio sync finished",
      );
      if (result.errors.length > 0) {
        logger.error(
          { scope: "attio.sync", errors: result.errors.slice(0, 20) },
          "attio sync had errors",
        );
      }
      return (
        result.companiesUpdated +
        result.companiesCreated +
        result.peopleUpserted +
        result.companyTeamsUpdated
      );
    } finally {
      running = false;
    }
  };
}
