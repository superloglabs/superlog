import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createIngestSourceFilter, ingestFilterKey } from "./ingest-source-filter.js";

// A controllable clock so we can drive TTL expiry deterministically.
function clock(start = 1_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

// Wait a microtask turn for the gate's background refresh promise to settle.
const tick = () => new Promise((r) => setImmediate(r));

test("allows everything before the first refresh resolves (fail-open default)", () => {
  const filter = createIngestSourceFilter({ loadDisabled: async () => new Set(["aws:logs"]) });
  // First call returns before the async load completes → allow.
  assert.equal(filter.allows("p1", "aws", "logs"), true);
});

test("blocks a disabled (source, signal) once loaded; allows the rest", async () => {
  const c = clock();
  const filter = createIngestSourceFilter({
    loadDisabled: async () => new Set([ingestFilterKey("aws", "logs")]),
    now: c.now,
  });
  filter.allows("p1", "aws", "logs"); // primes the cache (kicks off refresh)
  await tick();
  assert.equal(filter.allows("p1", "aws", "logs"), false, "aws logs disabled");
  assert.equal(filter.allows("p1", "aws", "metrics"), true, "aws metrics still on");
  assert.equal(filter.allows("p1", "otlp", "logs"), true, "otlp logs unaffected");
});

test("re-reads after the TTL expires (toggle takes effect)", async () => {
  const c = clock();
  let disabled = new Set([ingestFilterKey("aws", "logs")]);
  const filter = createIngestSourceFilter({
    loadDisabled: async () => new Set(disabled),
    ttlMs: 1000,
    now: c.now,
  });
  filter.allows("p1", "aws", "logs");
  await tick();
  assert.equal(filter.allows("p1", "aws", "logs"), false);

  // Project re-enables aws logs; within the TTL we still serve the stale verdict.
  disabled = new Set();
  assert.equal(filter.allows("p1", "aws", "logs"), false, "stale within TTL");

  // After the TTL, the next call schedules a refresh; once it lands, allowed.
  c.advance(1001);
  filter.allows("p1", "aws", "logs"); // triggers refresh
  await tick();
  assert.equal(filter.allows("p1", "aws", "logs"), true, "re-enabled after refresh");
});

test("fails open when the loader throws", async () => {
  const filter = createIngestSourceFilter({
    loadDisabled: async () => {
      throw new Error("db down");
    },
  });
  filter.allows("p1", "otlp", "traces");
  await tick();
  // Loader errored → cached empty disabled set → everything allowed.
  assert.equal(filter.allows("p1", "otlp", "traces"), true);
  assert.equal(filter.allows("p1", "aws", "metrics"), true);
});

test("isolates projects from each other", async () => {
  const c = clock();
  const filter = createIngestSourceFilter({
    loadDisabled: async (projectId) =>
      projectId === "blocked" ? new Set([ingestFilterKey("aws", "logs")]) : new Set(),
    now: c.now,
  });
  filter.allows("blocked", "aws", "logs");
  filter.allows("open", "aws", "logs");
  await tick();
  assert.equal(filter.allows("blocked", "aws", "logs"), false);
  assert.equal(filter.allows("open", "aws", "logs"), true);
});
