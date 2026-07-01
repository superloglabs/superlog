import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createAuthKeyCache } from "./auth-key-cache.js";

test("returns null on miss", () => {
  const cache = createAuthKeyCache();
  assert.equal(cache.get("nonexistent"), null);
});

test("returns projectId on hit within TTL", () => {
  let t = 1000;
  const cache = createAuthKeyCache({ ttlMs: 60_000, now: () => t });
  cache.set("h1", "proj-A");
  t += 59_999; // just before expiry
  assert.equal(cache.get("h1"), "proj-A");
});

test("returns null after TTL expiry", () => {
  let t = 1000;
  const cache = createAuthKeyCache({ ttlMs: 60_000, now: () => t });
  cache.set("h1", "proj-A");
  t += 60_001; // past expiry
  assert.equal(cache.get("h1"), null);
});

test("removes expired entry from map on read", () => {
  let t = 1000;
  const cache = createAuthKeyCache({ ttlMs: 100, now: () => t });
  cache.set("h1", "proj-A");
  assert.equal(cache._size, 1);
  t += 200;
  cache.get("h1"); // triggers eviction
  assert.equal(cache._size, 0);
});

test("overwrites an existing entry", () => {
  const cache = createAuthKeyCache();
  cache.set("h1", "proj-A");
  cache.set("h1", "proj-B");
  assert.equal(cache.get("h1"), "proj-B");
  assert.equal(cache._size, 1);
});

test("evicts the oldest entry when at capacity", () => {
  const cache = createAuthKeyCache({ maxEntries: 3 });
  cache.set("h1", "p1");
  cache.set("h2", "p2");
  cache.set("h3", "p3");
  assert.equal(cache._size, 3);
  // adding a 4th evicts the oldest (h1)
  cache.set("h4", "p4");
  assert.equal(cache._size, 3);
  assert.equal(cache.get("h1"), null);
  assert.equal(cache.get("h2"), "p2");
  assert.equal(cache.get("h3"), "p3");
  assert.equal(cache.get("h4"), "p4");
});

test("does not evict when refreshing a key already in the map", () => {
  const cache = createAuthKeyCache({ maxEntries: 3 });
  cache.set("h1", "p1");
  cache.set("h2", "p2");
  cache.set("h3", "p3");
  // refreshing an existing key must not evict any entry
  cache.set("h1", "p1-updated");
  assert.equal(cache._size, 3);
  assert.equal(cache.get("h1"), "p1-updated");
  assert.equal(cache.get("h2"), "p2");
  assert.equal(cache.get("h3"), "p3");
});

test("multiple keys are independent", () => {
  const cache = createAuthKeyCache();
  cache.set("h1", "proj-A");
  cache.set("h2", "proj-B");
  assert.equal(cache.get("h1"), "proj-A");
  assert.equal(cache.get("h2"), "proj-B");
});
