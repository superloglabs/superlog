import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { runWorker } from "./runtime.js";

const EMPTY_TICK = {
  spans: 0,
  logs: 0,
  agentRuns: 0,
  agentChats: 0,
  alerts: 0,
  digests: 0,
  webhooks: 0,
  autorecoveryProposals: 0,
  observedEscalations: 0,
  usageReported: 0,
};

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
