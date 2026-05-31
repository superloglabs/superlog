import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_ATTIO_SYNC_INTERVAL_MS, resolveAttioSyncIntervalMs } from "./config.js";

test("resolveAttioSyncIntervalMs only accepts positive finite intervals", () => {
  assert.equal(resolveAttioSyncIntervalMs(12_000), 12_000);
  assert.equal(resolveAttioSyncIntervalMs("30000"), 30_000);
  assert.equal(resolveAttioSyncIntervalMs(-1), DEFAULT_ATTIO_SYNC_INTERVAL_MS);
  assert.equal(resolveAttioSyncIntervalMs("0"), DEFAULT_ATTIO_SYNC_INTERVAL_MS);
  assert.equal(
    resolveAttioSyncIntervalMs(Number.POSITIVE_INFINITY),
    DEFAULT_ATTIO_SYNC_INTERVAL_MS,
  );
  assert.equal(resolveAttioSyncIntervalMs("not-a-number"), DEFAULT_ATTIO_SYNC_INTERVAL_MS);
  assert.equal(resolveAttioSyncIntervalMs(undefined), DEFAULT_ATTIO_SYNC_INTERVAL_MS);
});
