// Pub/Sub pushes one HTTP request per Cloud Logging entry, so a busy GCP
// project produces tens of thousands of requests a minute for a single
// connection. Anything the push route does against Postgres per request runs
// at that rate, and a same-row UPDATE per request queues every push (and every
// other proxy query sharing the pool) behind the row lock. Both helpers here
// keep that per-request work in memory.

import { GCP_PUBSUB_INGESTIBLE_STATUSES } from "./gcp-pubsub.js";

type CacheEntry<T> = {
  connection: T | null;
  expiresAt: number;
};

const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_MISSING_TTL_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_RECEIPT_INTERVAL_MS = 60_000;

export type GcpConnectionState = { status: string; revokedAt: Date | null };

export function isIngestibleGcpConnection(row: GcpConnectionState | null): boolean {
  return (
    row !== null &&
    row.revokedAt === null &&
    (GCP_PUBSUB_INGESTIBLE_STATUSES as readonly string[]).includes(row.status)
  );
}

/**
 * How long a lookup result may be served from memory. Ingestible rows are
 * cached for the full TTL (status changes propagate within it). Unknown and
 * revoked connections are settled, so they are cached as missing for a shorter
 * TTL: a disconnected subscription that keeps pushing then stays off the
 * database. Rows still being set up (pending/provisioning) or failed can become
 * ingestible at any moment, and the route acks a non-ingestible push as
 * dropped, so those are never cached.
 */
export function gcpConnectionCacheTtlMs(row: GcpConnectionState | null): number {
  if (row === null || row.revokedAt !== null) return DEFAULT_MISSING_TTL_MS;
  if (isIngestibleGcpConnection(row)) return DEFAULT_CACHE_TTL_MS;
  return 0;
}

/**
 * Cache connection lookups by id and collapse concurrent misses into one query.
 * `ttlFor` decides per result how long it may be served (0 = do not cache).
 * Lookup errors are not cached.
 */
export function createGcpConnectionCache<T>(deps: {
  lookup: (connectionId: string) => Promise<T | null>;
  ttlFor: (connection: T | null) => number;
  maxEntries?: number;
  now?: () => number;
}) {
  const maxEntries = Math.max(1, deps.maxEntries ?? DEFAULT_MAX_ENTRIES);
  const now = deps.now ?? Date.now;
  const cache = new Map<string, CacheEntry<T>>();
  const inflight = new Map<string, Promise<T | null>>();

  function setEntry(connectionId: string, entry: CacheEntry<T>): void {
    if (!cache.has(connectionId) && cache.size >= maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(connectionId, entry);
  }

  return {
    async resolve(connectionId: string): Promise<T | null> {
      const entry = cache.get(connectionId);
      if (entry && entry.expiresAt > now()) return entry.connection;
      const pending = inflight.get(connectionId);
      if (pending) return pending;

      const lookup = deps
        .lookup(connectionId)
        .then((connection) => {
          const ttlMs = deps.ttlFor(connection);
          if (ttlMs > 0) setEntry(connectionId, { connection, expiresAt: now() + ttlMs });
          return connection;
        })
        .finally(() => inflight.delete(connectionId));
      inflight.set(connectionId, lookup);
      return lookup;
    },
  };
}

/**
 * Persist "last log received" at most once per connection per interval per
 * proxy instance. The timestamp is status metadata, so dropping the
 * intermediate writes loses nothing. A failed write clears the throttle so the
 * next receipt retries.
 */
export function createLogReceiptRecorder(deps: {
  write: (connectionId: string, receivedAt: Date) => Promise<void>;
  onError?: (error: unknown, connectionId: string) => void;
  intervalMs?: number;
  maxEntries?: number;
  now?: () => number;
}) {
  const intervalMs = deps.intervalMs ?? DEFAULT_RECEIPT_INTERVAL_MS;
  const maxEntries = Math.max(1, deps.maxEntries ?? DEFAULT_MAX_ENTRIES);
  const now = deps.now ?? Date.now;
  const nextWriteAt = new Map<string, number>();

  return {
    record(connectionId: string): void {
      const receivedAt = now();
      if ((nextWriteAt.get(connectionId) ?? 0) > receivedAt) return;
      if (!nextWriteAt.has(connectionId) && nextWriteAt.size >= maxEntries) {
        const oldest = nextWriteAt.keys().next().value;
        if (oldest !== undefined) nextWriteAt.delete(oldest);
      }
      const writeAfter = receivedAt + intervalMs;
      nextWriteAt.set(connectionId, writeAfter);
      void deps.write(connectionId, new Date(receivedAt)).catch((error: unknown) => {
        if (nextWriteAt.get(connectionId) === writeAfter) nextWriteAt.delete(connectionId);
        deps.onError?.(error, connectionId);
      });
    },
  };
}
