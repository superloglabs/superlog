import assert from "node:assert/strict";
import { test } from "node:test";
import { createGcpConnectionCache, createLogReceiptRecorder } from "./gcp-pubsub-connection.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

type Connection = { id: string; projectId: string };

test("repeated pushes for one connection reuse the cached connection", async () => {
  let lookups = 0;
  const cache = createGcpConnectionCache<Connection>({
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
    lookup: async (id) => {
      lookups += 1;
      return { id, projectId: `project-${lookups}` };
    },
    ttlMs: 60_000,
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
    lookup: async () => {
      lookups += 1;
      return null;
    },
    missingTtlMs: 30_000,
    now: () => now,
  });

  assert.equal(await cache.resolve("conn-gone"), null);
  assert.equal(await cache.resolve("conn-gone"), null);
  assert.equal(lookups, 1);

  now += 30_001;
  assert.equal(await cache.resolve("conn-gone"), null);
  assert.equal(lookups, 2);
});

test("a failed connection lookup is not cached", async () => {
  let lookups = 0;
  const cache = createGcpConnectionCache<Connection>({
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
