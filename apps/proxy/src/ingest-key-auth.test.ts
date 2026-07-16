import assert from "node:assert/strict";
import { test } from "node:test";
import { createIngestKeyCache, createLastUsedRecorder } from "./ingest-key-auth.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("repeated authentication of an ingest key reuses the cached identity", async () => {
  let lookups = 0;
  const cache = createIngestKeyCache({
    lookup: async () => {
      lookups += 1;
      return {
        id: "key-1",
        projectId: "project-1",
        lastUsedAt: null,
        revokedAt: null,
      };
    },
  });

  const first = await cache.resolve("hash-1");
  const second = await cache.resolve("hash-1");

  assert.deepEqual(second, first);
  assert.equal(lookups, 1);
});

test("an expired ingest-key identity is refreshed", async () => {
  let now = 1_000;
  let lookups = 0;
  const cache = createIngestKeyCache({
    lookup: async () => {
      lookups += 1;
      return {
        id: "key-1",
        projectId: `project-${lookups}`,
        lastUsedAt: null,
        revokedAt: null,
      };
    },
    ttlMs: 60_000,
    now: () => now,
  });

  assert.equal((await cache.resolve("hash-1"))?.projectId, "project-1");
  now += 60_001;
  assert.equal((await cache.resolve("hash-1"))?.projectId, "project-2");
  assert.equal(lookups, 2);
});

test("a missing ingest key is not cached", async () => {
  let lookups = 0;
  const cache = createIngestKeyCache({
    lookup: async () => {
      lookups += 1;
      if (lookups === 1) return null;
      return {
        id: "key-1",
        projectId: "project-1",
        lastUsedAt: null,
        revokedAt: null,
      };
    },
  });

  assert.equal(await cache.resolve("hash-1"), null);
  assert.equal((await cache.resolve("hash-1"))?.projectId, "project-1");
  assert.equal(lookups, 2);
});

test("concurrent authentication requests share one ingest-key lookup", async () => {
  let lookups = 0;
  let releaseLookup: (() => void) | undefined;
  const lookupBlocked = new Promise<void>((resolve) => {
    releaseLookup = resolve;
  });
  const cache = createIngestKeyCache({
    lookup: async () => {
      lookups += 1;
      await lookupBlocked;
      return {
        id: "key-1",
        projectId: "project-1",
        lastUsedAt: null,
        revokedAt: null,
      };
    },
  });

  const first = cache.resolve("hash-1");
  const second = cache.resolve("hash-1");
  releaseLookup?.();

  assert.deepEqual(await second, await first);
  assert.equal(lookups, 1);
});

test("the ingest-key cache evicts its oldest identity at the configured bound", async () => {
  const lookups = new Map<string, number>();
  const cache = createIngestKeyCache({
    lookup: async (keyHash) => {
      lookups.set(keyHash, (lookups.get(keyHash) ?? 0) + 1);
      return {
        id: keyHash,
        projectId: `project-${keyHash}`,
        lastUsedAt: null,
        revokedAt: null,
      };
    },
    maxEntries: 2,
  });

  await cache.resolve("hash-1");
  await cache.resolve("hash-2");
  await cache.resolve("hash-3");
  await cache.resolve("hash-1");

  assert.equal(lookups.get("hash-1"), 2);
  assert.equal(lookups.get("hash-2"), 1);
  assert.equal(lookups.get("hash-3"), 1);
});

test("repeated use of one ingest key produces one last-used write per interval", () => {
  let writes = 0;
  const recorder = createLastUsedRecorder({
    write: async () => {
      writes += 1;
    },
  });
  const identity = {
    id: "key-1",
    projectId: "project-1",
    lastUsedAt: new Date(0),
    revokedAt: null,
  };

  recorder.record(identity);
  recorder.record(identity);

  assert.equal(writes, 1);
});

test("last-used recording resumes after the interval", () => {
  let now = 1_000;
  let writes = 0;
  const recorder = createLastUsedRecorder({
    write: async () => {
      writes += 1;
    },
    intervalMs: 60_000,
    now: () => now,
  });
  const identity = {
    id: "key-1",
    projectId: "project-1",
    lastUsedAt: new Date(0),
    revokedAt: null,
  };

  recorder.record(identity);
  now += 60_001;
  recorder.record(identity);

  assert.equal(writes, 2);
});

test("last-used throttling evicts its oldest key at the configured bound", () => {
  const writes = new Map<string, number>();
  const recorder = createLastUsedRecorder({
    write: async (keyId) => {
      writes.set(keyId, (writes.get(keyId) ?? 0) + 1);
    },
    maxEntries: 2,
  });
  const identity = (id: string) => ({
    id,
    projectId: `project-${id}`,
    lastUsedAt: new Date(0),
    revokedAt: null,
  });

  recorder.record(identity("key-1"));
  recorder.record(identity("key-2"));
  recorder.record(identity("key-3"));
  recorder.record(identity("key-1"));

  assert.equal(writes.get("key-1"), 2);
  assert.equal(writes.get("key-2"), 1);
  assert.equal(writes.get("key-3"), 1);
});

test("a failed last-used write can be retried by the next request", async () => {
  let attempts = 0;
  let errors = 0;
  const recorder = createLastUsedRecorder({
    write: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("database unavailable");
    },
    onError: () => {
      errors += 1;
    },
  });
  const identity = {
    id: "key-1",
    projectId: "project-1",
    lastUsedAt: new Date(0),
    revokedAt: null,
  };

  recorder.record(identity);
  await flush();
  recorder.record(identity);
  await flush();

  assert.equal(attempts, 2);
  assert.equal(errors, 1);
});

test("the first-use callback runs once after the last-used write succeeds", async () => {
  let firstUses = 0;
  const recorder = createLastUsedRecorder({
    write: async () => undefined,
  });
  const identity = {
    id: "key-1",
    projectId: "project-1",
    lastUsedAt: null,
    revokedAt: null,
  };

  recorder.record(identity, async () => {
    firstUses += 1;
  });
  await flush();
  recorder.record(identity, async () => {
    firstUses += 1;
  });
  await flush();

  assert.equal(firstUses, 1);
  assert.notEqual(identity.lastUsedAt, null);
});
