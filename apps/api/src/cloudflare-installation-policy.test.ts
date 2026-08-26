import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  cloudflarePendingWorkerDestinationReplacements,
  cloudflareWorkerDestinationRemovalSlugs,
  cloudflareWorkerWiringMode,
} from "./cloudflare-installation-policy.js";

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

test("bulk unwiring includes active and pending destination slugs", () => {
  assert.deepEqual(
    cloudflareWorkerDestinationRemovalSlugs({
      traces: "active-traces",
      logs: "active-logs",
      metrics: "active-metrics",
      __previous_traces_0: "previous-traces-a",
      __previous_traces_1: "previous-traces-b",
      __previous_logs_0: "previous-logs",
    }),
    {
      traces: ["active-traces", "previous-traces-a", "previous-traces-b"],
      logs: ["active-logs", "previous-logs"],
    },
  );
});

test("wiring retries retained destination replacements before adding active slugs", () => {
  assert.deepEqual(
    cloudflarePendingWorkerDestinationReplacements({
      traces: "active-traces",
      logs: "active-logs",
      __previous_traces_0: "previous-traces-a",
      __previous_traces_1: "previous-traces-b",
      __previous_logs_0: "previous-logs",
    }),
    [
      { traces: { from: "previous-traces-a", to: "active-traces" } },
      { traces: { from: "previous-traces-b", to: "active-traces" } },
      { logs: { from: "previous-logs", to: "active-logs" } },
    ],
  );
});
