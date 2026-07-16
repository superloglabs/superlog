export type IngestKeyIdentity = {
  id: string;
  projectId: string;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
};

type CacheEntry = {
  identity: IngestKeyIdentity | null;
  expiresAt: number;
};

const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 50_000;
const DEFAULT_LAST_USED_INTERVAL_MS = 60_000;

export function createIngestKeyCache(deps: {
  lookup: (keyHash: string) => Promise<IngestKeyIdentity | null>;
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}) {
  const ttlMs = deps.ttlMs ?? DEFAULT_CACHE_TTL_MS;
  const maxEntries = Math.max(1, deps.maxEntries ?? DEFAULT_MAX_ENTRIES);
  const now = deps.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<IngestKeyIdentity | null>>();

  function setEntry(keyHash: string, entry: CacheEntry): void {
    if (!cache.has(keyHash) && cache.size >= maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(keyHash, entry);
  }

  return {
    async resolve(keyHash: string): Promise<IngestKeyIdentity | null> {
      const entry = cache.get(keyHash);
      if (entry && entry.expiresAt > now()) return entry.identity;
      const pending = inflight.get(keyHash);
      if (pending) return pending;

      const lookup = deps
        .lookup(keyHash)
        .then((identity) => {
          setEntry(keyHash, { identity, expiresAt: now() + ttlMs });
          return identity;
        })
        .finally(() => inflight.delete(keyHash));
      inflight.set(keyHash, lookup);
      return lookup;
    },
  };
}

export function createLastUsedRecorder(deps: {
  write: (keyId: string, usedAt: Date) => Promise<void>;
  onError?: (error: unknown, identity: IngestKeyIdentity) => void;
  intervalMs?: number;
  maxEntries?: number;
  now?: () => number;
}) {
  const intervalMs = deps.intervalMs ?? DEFAULT_LAST_USED_INTERVAL_MS;
  const maxEntries = Math.max(1, deps.maxEntries ?? DEFAULT_MAX_ENTRIES);
  const now = deps.now ?? Date.now;
  const nextWriteAt = new Map<string, number>();

  return {
    record(
      identity: IngestKeyIdentity,
      onFirstUse?: (identity: IngestKeyIdentity) => Promise<void>,
    ): void {
      const usedAt = now();
      if ((nextWriteAt.get(identity.id) ?? 0) > usedAt) return;
      if (!nextWriteAt.has(identity.id) && nextWriteAt.size >= maxEntries) {
        const oldest = nextWriteAt.keys().next().value;
        if (oldest !== undefined) nextWriteAt.delete(oldest);
      }
      const writeAfter = usedAt + intervalMs;
      nextWriteAt.set(identity.id, writeAfter);
      const usedAtDate = new Date(usedAt);
      const isFirstUse = identity.lastUsedAt === null;
      void deps.write(identity.id, usedAtDate).then(
        () => {
          identity.lastUsedAt = usedAtDate;
          if (isFirstUse && onFirstUse) {
            void Promise.resolve()
              .then(() => onFirstUse(identity))
              .catch((error) => deps.onError?.(error, identity));
          }
        },
        (error) => {
          if (nextWriteAt.get(identity.id) === writeAfter) nextWriteAt.delete(identity.id);
          deps.onError?.(error, identity);
        },
      );
    },
  };
}
