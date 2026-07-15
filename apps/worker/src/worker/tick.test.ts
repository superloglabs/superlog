// The db client throws at import time when DATABASE_URL is unset; these tests
// never connect (same shim as agent-run.test.ts).
import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { type SkippableTickStep, createWorkerTick } from "./tick.js";

const ALL_SKIPPABLE: SkippableTickStep[] = [
  "agent_runs",
  "agent_chats",
  "alerts",
  "digests",
  "webhooks",
  "observation",
];

test("skipped steps never run; the telemetry scan always does", async () => {
  const scanned: string[] = [];
  const tick = createWorkerTick({
    clickhouse: {} as Parameters<typeof createWorkerTick>[0]["clickhouse"],
    telemetryIngestor: {
      tickSpans: async () => {
        scanned.push("spans");
        return 3;
      },
      tickLogs: async () => {
        scanned.push("logs");
        return 4;
      },
    } as Parameters<typeof createWorkerTick>[0]["telemetryIngestor"],
    skipSteps: new Set(ALL_SKIPPABLE),
  });

  // With every skippable step skipped, the tick must touch nothing but the
  // ingestor — the real step modules would hit the (absent) database.
  const result = await tick();

  assert.deepEqual(scanned, ["spans", "logs"]);
  assert.deepEqual(result, {
    spans: 3,
    logs: 4,
    agentRuns: 0,
    agentChats: 0,
    alerts: 0,
    digests: 0,
    webhooks: 0,
    observedEscalations: 0,
  });
});
