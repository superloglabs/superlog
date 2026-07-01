// Auth key validation cache for the ingest proxy.
//
// Every OTLP request validates an API key against Postgres. Without a cache,
// each request holds a connection for the duration of the query. Under Postgres
// load that stretches to 1–25 seconds per request (observed 2026-07-01), which
// pushes all concurrent requests past the upstream OTLP client timeout and turns
// a transient DB slowdown into a total ingest outage.
//
// This cache trades a bounded revocation lag (≤ TTL, default 60 s) for
// resilience: on a DB slowdown the hot path never blocks. Only valid (non-revoked)
// keys are cached so a revocation takes effect on the next Postgres read, not
// after a TTL. An expired entry is evicted on read and the next request re-queries
// Postgres, same as the uncached path.
//
// Memory is bounded: once the map hits MAX_ENTRIES the oldest entry is evicted
// (Map preserves insertion order). 10 k entries × ~80 bytes per entry ≈ 800 KB —
// well within the proxy's per-task memory budget.

type Entry = { projectId: string; expiresAt: number };

export const AUTH_CACHE_TTL_MS = 60_000;
export const AUTH_CACHE_MAX_ENTRIES = 10_000;

/** An in-memory auth key cache. The module exports a shared singleton cache and
 *  also exports the factory so tests can create isolated instances. */
export function createAuthKeyCache(opts?: { ttlMs?: number; maxEntries?: number; now?: () => number }) {
  const ttlMs = opts?.ttlMs ?? AUTH_CACHE_TTL_MS;
  const maxEntries = opts?.maxEntries ?? AUTH_CACHE_MAX_ENTRIES;
  const now = opts?.now ?? Date.now;
  const cache = new Map<string, Entry>();

  function evict(): void {
    // Map preserves insertion order — oldest entry is first.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }

  return {
    /** Return the cached projectId for a key hash, or null on miss/expiry. */
    get(keyHash: string): string | null {
      const entry = cache.get(keyHash);
      if (!entry) return null;
      if (entry.expiresAt <= now()) {
        cache.delete(keyHash);
        return null;
      }
      return entry.projectId;
    },

    /** Cache a successful (non-revoked) auth result.
     *  Never call this for revoked or missing keys — only valid results are
     *  cached so revocations take effect immediately on the next DB read. */
    set(keyHash: string, projectId: string): void {
      if (!cache.has(keyHash) && cache.size >= maxEntries) evict();
      cache.set(keyHash, { projectId, expiresAt: now() + ttlMs });
    },

    /** Exposed for testing only. */
    get _size(): number {
      return cache.size;
    },
  };
}

/** Module-level singleton used by the proxy. Tests use createAuthKeyCache(). */
export const authKeyCache = createAuthKeyCache();
