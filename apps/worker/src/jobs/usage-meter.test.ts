import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClickHouseClient } from "@clickhouse/client";
import type { JobDeps } from "../jobs.js";
import { createUsageMeterJob } from "./usage-meter.js";

test("usage metering uses an isolated client with bounded server and client execution", async () => {
  let requestTimeout: number | undefined;
  let maxExecutionTime: unknown;
  let meterRuns = 0;
  let closes = 0;
  let jobSignal: AbortSignal | undefined;
  const clickhouse = {
    query: async () => {
      throw new Error("not used");
    },
    close: async () => {
      closes += 1;
    },
  } as unknown as Pick<ClickHouseClient, "query" | "close">;
  const definition = createUsageMeterJob({
    env: { AUTUMN_SECRET_KEY: "configured" },
    createClient: (config) => {
      requestTimeout = config.request_timeout;
      maxExecutionTime = config.clickhouse_settings?.max_execution_time;
      return clickhouse;
    },
    createMeter: (options) => {
      assert.equal(options.clickhouse, clickhouse);
      assert.equal(options.intervalMs, 0);
      jobSignal = (options as typeof options & { signal?: AbortSignal }).signal;
      return async () => {
        meterRuns += 1;
        return 1;
      };
    },
  });

  assert.equal(definition.schedule, "* * * * *");
  assert.equal(definition.expireInSeconds, 120);
  const handler = await definition.create({ db: {} } as JobDeps);
  assert.ok(handler);
  await handler();

  assert.equal(requestTimeout, 30_000);
  assert.equal(maxExecutionTime, 25);
  assert.ok(jobSignal);
  assert.equal(meterRuns, 1);
  assert.equal(closes, 1);
});

test("usage metering aborts in-flight work before its durable lease expires", async () => {
  let aborted = false;
  let closes = 0;
  const definition = createUsageMeterJob({
    env: { AUTUMN_SECRET_KEY: "configured" },
    jobTimeoutMs: 5,
    createClient: () => ({
      query: async () => {
        throw new Error("not used");
      },
      close: async () => {
        closes += 1;
      },
    }),
    createMeter:
      ({ signal }) =>
      async () => {
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            aborted = true;
            resolve();
            return;
          }
          signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          );
        });
        return 0;
      },
  });

  assert.equal(definition.expireInSeconds, 31);
  const handler = await definition.create({ db: {} } as JobDeps);
  assert.ok(handler);
  const keepEventLoopAlive = setTimeout(() => {}, 100);
  try {
    await handler();
  } finally {
    clearTimeout(keepEventLoopAlive);
  }

  assert.equal(aborted, true);
  assert.equal(closes, 1);
});
