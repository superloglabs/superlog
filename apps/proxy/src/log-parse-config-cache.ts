// Per-project log-parse config cache for the ingest-consumer's direct-to-CH
// decode path. Same discipline as ingest-source-filter.ts: a sync hot-path read
// backed by a TTL cache that FAILS OPEN (returns the default config) on a miss
// or a DB error and only schedules a background refresh. Getting severity
// detection slightly stale is fine; blocking the decode loop on Postgres is not.
import {
  DEFAULT_LOG_PARSE_CONFIG,
  resolveLogParseConfig,
  type LogParseConfig,
} from "@superlog/db/log-severity";
import { logger } from "./logger.js";

export type LogParseConfigCache = {
  // Sync, hot-path. Returns the project's resolved parse config, or the default
  // (everything enabled with the built-in keys) until a load resolves.
  get(projectId: string): LogParseConfig;
};

type Entry = { config: LogParseConfig; expiresAt: number };

const DEFAULT_TTL_MS = 30_000;
const ERROR_TTL_MS = 10_000;
const MAX_ENTRIES = 20_000;

export function createLogParseConfigCache(deps: {
  loadConfig: (projectId: string) => Promise<LogParseConfig>;
  ttlMs?: number;
  now?: () => number;
}): LogParseConfigCache {
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const now = deps.now ?? Date.now;
  const cache = new Map<string, Entry>();
  const inflight = new Set<string>();

  function setEntry(projectId: string, entry: Entry): void {
    if (!cache.has(projectId) && cache.size >= MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(projectId, entry);
  }

  function refresh(projectId: string): void {
    if (inflight.has(projectId)) return;
    inflight.add(projectId);
    void (async () => {
      try {
        const config = resolveLogParseConfig(await deps.loadConfig(projectId));
        setEntry(projectId, { config, expiresAt: now() + ttlMs });
      } catch (err) {
        setEntry(projectId, {
          config: DEFAULT_LOG_PARSE_CONFIG,
          expiresAt: now() + ERROR_TTL_MS,
        });
        logger.warn(
          {
            scope: "ingest.log_parse_config",
            projectId,
            err: err instanceof Error ? err.message : String(err),
          },
          "log-parse-config refresh failed; using defaults (fail-open)",
        );
      } finally {
        inflight.delete(projectId);
      }
    })();
  }

  return {
    get(projectId) {
      const entry = cache.get(projectId);
      if (!entry || entry.expiresAt <= now()) refresh(projectId);
      return entry?.config ?? DEFAULT_LOG_PARSE_CONFIG;
    },
  };
}
