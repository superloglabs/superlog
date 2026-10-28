import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createGcpConnectionCache,
  createLogReceiptRecorder,
  gcpConnectionCacheTtlMs,
  isIngestibleGcpConnection,
} from "./gcp-pubsub-connection.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

type Connection = { id: string; projectId: string };

const fixedTtl = (connection: Connection | null) => (connection ? 60_000 : 30_000);

test("repeated pushes for one connection reuse the cached connection", async () => {
  let lookups = 0;
  const cache = createGcpConnectionCache<Connection>({
    ttlFor: fixedTtl,
    lookup: async (id) => {
      lookups += 1;
      return { id, projectId: "project-1" };
    },
  });

  const first = await cache.resolve("conn-1");
  const second = await cache.resolve("conn-1");

  assert.deepEqual(second, first);
  assert.equal(lookups, 1);
});

test("a burst of concurrent pushes shares one connection lookup", async () => {
  let lookups = 0;
  let release: (value: Connection) => void = () => {};
  const cache = createGcpConnectionCache<Connection>({
    ttlFor: fixedTtl,
    lookup: () => {
      lookups += 1;
      return new Promise<Connection>((resolve) => {
        release = resolve;
      });
    },
  });

  const pending = Array.from({ length: 50 }, () => cache.resolve("conn-1"));
  release({ id: "conn-1", projectId: "project-1" });
  const results = await Promise.all(pending);

  assert.equal(lookups, 1);
  assert.ok(results.every((r) => r?.projectId === "project-1"));
});

test("an expired connection is looked up again", async () => {
  let now = 1_000;
  let lookups = 0;
  const cache = createGcpConnectionCache<Connection>({
    ttlFor: fixedTtl,
    lookup: async (id) => {
      lookups += 1;
      return { id, projectId: `project-${lookups}` };
    },
    now: () => now,
  });

  assert.equal((await cache.resolve("conn-1"))?.projectId, "project-1");
  now += 60_001;
  assert.equal((await cache.resolve("conn-1"))?.projectId, "project-2");
  assert.equal(lookups, 2);
});

test("an unknown or disconnected connection is cached so its pushes stay off the database", async () => {
  let now = 1_000;
  let lookups = 0;
  const cache = createGcpConnectionCache<Connection>({
    ttlFor: fixedTtl,
    lookup: async () => {
      lookups += 1;
      return null;
    },
    now: () => now,
  });

  assert.equal(await cache.resolve("conn-gone"), null);
  assert.equal(await cache.resolve("conn-gone"), null);
  assert.equal(lookups, 1);

  now += 30_001;
  assert.equal(await cache.resolve("conn-gone"), null);
  assert.equal(lookups, 2);
});

test("a connection whose TTL is zero is looked up on every push", async () => {
  let lookups = 0;
  const cache = createGcpConnectionCache<Connection>({
    ttlFor: () => 0,
    lookup: async (id) => {
      lookups += 1;
      return { id, projectId: "project-1" };
    },
  });

  await cache.resolve("conn-1");
  await cache.resolve("conn-1");
  assert.equal(lookups, 2);
});

test("ingestible connections are cached for the full TTL", () => {
  for (const status of ["connected", "disconnecting", "disconnect_failed"]) {
    const row = { status, revokedAt: null };
    assert.equal(isIngestibleGcpConnection(row), true, status);
    assert.equal(gcpConnectionCacheTtlMs(row), 60_000, status);
  }
});

test("unknown and revoked connections are settled and cached as missing", () => {
  assert.equal(isIngestibleGcpConnection(null), false);
  assert.equal(gcpConnectionCacheTtlMs(null), 30_000);
  const revoked = { status: "connected", revokedAt: new Date(0) };
  assert.equal(isIngestibleGcpConnection(revoked), false);
  assert.equal(gcpConnectionCacheTtlMs(revoked), 30_000);
});

test("connections still being set up are never cached, so pushes after activation are ingested", () => {
  for (const status of ["pending", "provisioning", "failed"]) {
    const row = { status, revokedAt: null };
    assert.equal(isIngestibleGcpConnection(row), false, status);
    assert.equal(gcpConnectionCacheTtlMs(row), 0, status);
  }
});

test("a failed connection lookup is not cached", async () => {
  let lookups = 0;
  const cache = createGcpConnectionCache<Connection>({
    ttlFor: fixedTtl,
    lookup: async (id) => {
      lookups += 1;
      if (lookups === 1) throw new Error("db down");
      return { id, projectId: "project-1" };
    },
  });

  await assert.rejects(cache.resolve("conn-1"), /db down/);
  assert.equal((await cache.resolve("conn-1"))?.projectId, "project-1");
  assert.equal(lookups, 2);
});

test("many log receipts for one connection persist at most once per interval", async () => {
  let now = 1_000;
  const writes: Array<[string, number]> = [];
  const recorder = createLogReceiptRecorder({
    write: async (id, receivedAt) => {
      writes.push([id, receivedAt.getTime()]);
    },
    intervalMs: 60_000,
    now: () => now,
  });

  for (let i = 0; i < 1_000; i += 1) recorder.record("conn-1");
  await flush();
  assert.deepEqual(writes, [["conn-1", 1_000]]);

  now += 59_999;
  recorder.record("conn-1");
  await flush();
  assert.equal(writes.length, 1);

  now += 2;
  recorder.record("conn-1");
  await flush();
  assert.deepEqual(writes[1], ["conn-1", 61_001]);
});

test("log receipts for different connections persist independently", async () => {
  const writes: string[] = [];
  const recorder = createLogReceiptRecorder({
    write: async (id) => {
      writes.push(id);
    },
  });

  recorder.record("conn-1");
  recorder.record("conn-2");
  recorder.record("conn-1");
  await flush();

  assert.deepEqual(writes, ["conn-1", "conn-2"]);
});

test("a failed receipt write is retried on the next receipt", async () => {
  let attempts = 0;
  const errors: unknown[] = [];
  const recorder = createLogReceiptRecorder({
    write: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("db down");
    },
    onError: (error) => errors.push(error),
  });

  recorder.record("conn-1");
  await flush();
  recorder.record("conn-1");
  await flush();

  assert.equal(attempts, 2);
  assert.equal(errors.length, 1);
});
