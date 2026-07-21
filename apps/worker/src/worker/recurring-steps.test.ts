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
      ["sentry-issue-sweep", "sentry_events"],
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
  assert.ok((byQueue.get("sentry-issue-sweep") ?? 61) < 60, "Sentry issues must stay snappy");
  assert.ok((byQueue.get("agent-chat-sweep") ?? 61) < 60, "chat replies must stay snappy");
  assert.ok((byQueue.get("alert-evaluation") ?? 61) < 60, "alert evaluation must stay snappy");
});

test("a failed registration doesn't block the rest and is retried in the background", async () => {
  let digestCreateAttempts = 0;
  const consumers: string[] = [];
  const boss: RecurringBoss = {
    async createQueue(name) {
      if (name === "digest-sweep") {
        digestCreateAttempts += 1;
        if (digestCreateAttempts === 1) throw new Error("createQueue refused");
      }
    },
    async updateQueue() {},
    async work(name) {
      consumers.push(name);
    },
    async send() {
      return "job-id";
    },
    async schedule() {},
    async unschedule() {},
  };

  const migrated = await startRecurringSteps(boss, depsOf(), {
    logger: quietLogger,
    retryDelayMs: 5,
  });

  // The failed step must not block the others — and must NOT be reported as
  // registered (the caller never runs it locally; see RECURRING_TICK_STEPS).
  assert.ok(!migrated.has("digests"), "the failed step must be reported unregistered");
  assert.deepEqual([...migrated].sort(), [
    "agent_chats",
    "alerts",
    "observation",
    "sentry_events",
    "webhooks",
  ]);
  assert.ok(!consumers.includes("digest-sweep"));

  // The background retry completes the registration once the failure clears,
  // so a transient error doesn't leave the step dark until the next boot.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(digestCreateAttempts >= 2, "registration must be retried");
  assert.deepEqual(
    consumers.filter((name) => name === "digest-sweep"),
    ["digest-sweep"],
    "the retried step must get exactly one consumer",
  );

  // The shared dead-chain reviver rides along, once.
  assert.deepEqual(
    consumers.filter((name) => name === "recurring-reviver"),
    ["recurring-reviver"],
  );
});

test("registration retries stop once shutdown begins", async () => {
  let attempts = 0;
  const boss: RecurringBoss = {
    async createQueue(name) {
      if (name === "digest-sweep") {
        attempts += 1;
        throw new Error("createQueue refused");
      }
    },
    async updateQueue() {},
    async work() {},
    async send() {
      return "job-id";
    },
    async schedule() {},
    async unschedule() {},
  };
  const shutdown = new AbortController();

  await startRecurringSteps(boss, depsOf(), {
    logger: quietLogger,
    retryDelayMs: 5,
    shutdown: shutdown.signal,
  });
  shutdown.abort();
  const attemptsAtShutdown = attempts;
  await new Promise((resolve) => setTimeout(resolve, 30));

  // A retry already sleeping may fire once more at most; the chain of retries
  // must not keep hammering a draining process.
  assert.ok(attempts <= attemptsAtShutdown + 1, "retries must stop after shutdown");
});
