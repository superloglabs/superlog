import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { runWorker } from "./runtime.js";

const EMPTY_TICK = {
  spans: 0,
  logs: 0,
  agentRuns: 0,
  agentChats: 0,
  sentryEvents: 0,
  alerts: 0,
  digests: 0,
  webhooks: 0,
  autorecoveryProposals: 0,
  observedEscalations: 0,
  usageReported: 0,
};

test("the worker skips the poll interval and runs a second tick immediately when the ingest batch was full", async () => {
  const controller = new AbortController();
  const ticks: number[] = [];
  const start = Date.now();

  const worker = runWorker({
    // Use a very long poll interval so the test would time out if sleep is not skipped.
    pollIntervalMs: 60_000,
    batchSize: 5,
    signal: controller.signal,
    tick: async () => {
      ticks.push(Date.now() - start);
      // First tick: return spans === batchSize → batch was full, skip sleep.
      // Second tick: return 0 → no backlog, abort before sleeping.
      if (ticks.length === 1) return { ...EMPTY_TICK, spans: 5 };
      controller.abort();
      return EMPTY_TICK;
    },
  });

  await worker;

  assert.equal(ticks.length, 2, "worker must run a second tick without waiting for pollIntervalMs");
  assert.ok(
    ticks[1]! - ticks[0]! < 1_000,
    `second tick should start within 1s of first (elapsed: ${ticks[1]! - ticks[0]!}ms)`,
  );
});

test("the worker finishes its current tick and stops polling when shutdown begins", async () => {
  const controller = new AbortController();
  let ticks = 0;
  let releaseTick!: () => void;
  let markStarted!: () => void;
  const tickStarted = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const tickFinished = new Promise<void>((resolve) => {
    releaseTick = resolve;
  });

  const worker = runWorker({
    pollIntervalMs: 60_000,
    batchSize: 1,
    signal: controller.signal,
    tick: async () => {
      ticks += 1;
      markStarted();
      await tickFinished;
      return EMPTY_TICK;
    },
  });

  await tickStarted;
  controller.abort();
  releaseTick();
  await worker;

  assert.equal(ticks, 1);
});
