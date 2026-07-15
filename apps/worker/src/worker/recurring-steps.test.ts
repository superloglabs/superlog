// The db client throws at import time when DATABASE_URL is unset; these tests
// never connect (same shim as agent-run.test.ts).
import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RecurringStepsDeps } from "./recurring-steps.js";
import { buildRecurringSteps, startRecurringSteps } from "./recurring-steps.js";
import type { RecurringBoss } from "./recurring.js";

const quietLogger = { info: () => {}, warn: () => {}, error: () => {} };

function depsOf(overrides: Partial<RecurringStepsDeps> = {}): RecurringStepsDeps {
  return {
    clickhouse: {} as RecurringStepsDeps["clickhouse"],
    onIssueTransition: async () => {},
    ...overrides,
  };
}

test("every remaining sub-cron tick step has a chain", () => {
  assert.deepEqual(
    buildRecurringSteps(depsOf()).map((s) => [s.queue, s.tickStep]),
    [
      ["agent-chat-sweep", "agent_chats"],
      ["webhook-deliveries", "webhooks"],
      ["alert-evaluation", "alerts"],
      ["digest-sweep", "digests"],
      ["observation-sweep", "observation"],
    ],
  );
});

test("latency-sensitive sweeps keep a sub-minute cadence", () => {
  const byQueue = new Map(buildRecurringSteps(depsOf()).map((s) => [s.queue, s.intervalSeconds]));
  assert.ok((byQueue.get("webhook-deliveries") ?? 61) < 60, "webhook delivery must stay snappy");
  assert.ok((byQueue.get("agent-chat-sweep") ?? 61) < 60, "chat replies must stay snappy");
  assert.ok((byQueue.get("alert-evaluation") ?? 61) < 60, "alert evaluation must stay snappy");
});

test("a step that fails to register stays in the tick; the rest migrate", async () => {
  const boss: RecurringBoss = {
    async createQueue(name) {
      if (name === "digest-sweep") throw new Error("createQueue refused");
    },
    async updateQueue() {},
    async work() {},
    async send() {
      return "job-id";
    },
    async schedule() {},
  };

  const migrated = await startRecurringSteps(boss, depsOf(), quietLogger);

  assert.ok(!migrated.has("digests"), "the failed step must stay in the tick");
  assert.deepEqual([...migrated].sort(), ["agent_chats", "alerts", "observation", "webhooks"]);
});
