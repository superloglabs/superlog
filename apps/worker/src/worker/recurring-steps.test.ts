// The db client throws at import time when DATABASE_URL is unset; these tests
// never connect (same shim as agent-run.test.ts).
import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RecurringStepsDeps } from "./recurring-steps.js";
import {
  RECURRING_TICK_STEPS,
  buildRecurringSteps,
  startRecurringSteps,
} from "./recurring-steps.js";
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
  // The caller uses RECURRING_TICK_STEPS to skip chain-owned steps in the
  // tick, so it must cover exactly the steps that get chains.
  assert.deepEqual(
    [...RECURRING_TICK_STEPS].sort(),
    buildRecurringSteps(depsOf())
      .map((s) => s.tickStep)
      .sort(),
  );
});

test("latency-sensitive sweeps keep a sub-minute cadence", () => {
  const byQueue = new Map(buildRecurringSteps(depsOf()).map((s) => [s.queue, s.intervalSeconds]));
  assert.ok((byQueue.get("webhook-deliveries") ?? 61) < 60, "webhook delivery must stay snappy");
  assert.ok((byQueue.get("agent-chat-sweep") ?? 61) < 60, "chat replies must stay snappy");
  assert.ok((byQueue.get("alert-evaluation") ?? 61) < 60, "alert evaluation must stay snappy");
});

test("one step's registration failure doesn't block the rest", async () => {
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

  assert.ok(!migrated.has("digests"), "the failed step must be reported unregistered");
  assert.deepEqual([...migrated].sort(), ["agent_chats", "alerts", "observation", "webhooks"]);
});
