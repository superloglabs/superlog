import { strict as assert } from "node:assert";
import { test } from "node:test";
import { cloudflareWorkerWiringMode } from "./cloudflare-installation-policy.js";

test("a new Cloudflare connection waits for explicit Worker selection", () => {
  assert.deepEqual(cloudflareWorkerWiringMode(null), {
    autoWire: false,
    wireAfterConnect: false,
  });
});

test("a Cloudflare reconnect preserves the existing Worker wiring preference", () => {
  assert.deepEqual(cloudflareWorkerWiringMode(false), {
    autoWire: false,
    wireAfterConnect: false,
  });
  assert.deepEqual(cloudflareWorkerWiringMode(true), {
    autoWire: true,
    wireAfterConnect: true,
  });
});
