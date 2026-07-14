import assert from "node:assert/strict";
import { test } from "node:test";
import { drainWorker, shutdownWorkerProcess } from "./shutdown.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("shutdown drains the tick loop and active jobs before closing shared clients", async () => {
  const tick = deferred();
  const jobs = deferred();
  let pollingStopped = false;
  let clickhouseClosed = false;
  let stopOptions: unknown;

  const shutdown = drainWorker({
    stopTickLoop() {
      pollingStopped = true;
    },
    tickLoop: tick.promise,
    jobRunner: {
      async stop(options) {
        stopOptions = options;
        await jobs.promise;
      },
    },
    async closeClickHouse() {
      clickhouseClosed = true;
    },
  });

  await Promise.resolve();
  assert.equal(pollingStopped, true);
  assert.deepEqual(stopOptions, { graceful: true, timeout: 90_000 });
  assert.equal(clickhouseClosed, false);

  tick.resolve();
  await Promise.resolve();
  assert.equal(clickhouseClosed, false, "active jobs are still draining");

  jobs.resolve();
  await shutdown;
  assert.equal(clickhouseClosed, true);
});

test("shutdown closes shared clients even when draining active jobs fails", async () => {
  const tick = deferred();
  const jobStopCalled = deferred();
  let clickhouseClosed = false;
  const expected = new Error("job drain failed");

  const shutdown = drainWorker({
    stopTickLoop() {},
    tickLoop: tick.promise,
    jobRunner: {
      async stop() {
        jobStopCalled.resolve();
        throw expected;
      },
    },
    async closeClickHouse() {
      clickhouseClosed = true;
    },
  });
  const rejected = assert.rejects(shutdown, expected);

  await jobStopCalled.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(clickhouseClosed, false, "the tick loop is still draining");

  tick.resolve();
  await rejected;
  assert.equal(clickhouseClosed, true);
});

test("process shutdown drains work before flushing analytics and telemetry", async () => {
  const order: string[] = [];

  const exitCode = await shutdownWorkerProcess({
    async drain() {
      order.push("drain");
    },
    async shutdownAnalytics() {
      order.push("analytics");
    },
    async shutdownTelemetry() {
      order.push("telemetry");
    },
    onError() {},
  });

  assert.deepEqual(order, ["drain", "analytics", "telemetry"]);
  assert.equal(exitCode, 0);
});

test("process shutdown flushes remaining clients and exits non-zero after a failed phase", async () => {
  const order: string[] = [];
  const errors: string[] = [];

  const exitCode = await shutdownWorkerProcess({
    async drain() {
      order.push("drain");
      throw new Error("drain failed");
    },
    async shutdownAnalytics() {
      order.push("analytics");
    },
    async shutdownTelemetry() {
      order.push("telemetry");
    },
    onError(phase, error) {
      errors.push(`${phase}:${error instanceof Error ? error.message : String(error)}`);
    },
  });

  assert.deepEqual(order, ["drain", "analytics", "telemetry"]);
  assert.deepEqual(errors, ["drain:drain failed"]);
  assert.equal(exitCode, 1);
});
