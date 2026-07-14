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
      return async () => {
        meterRuns += 1;
        return 1;
      };
    },
  });

  assert.equal(definition.schedule, "* * * * *");
  const handler = await definition.create({ db: {} } as JobDeps);
  assert.ok(handler);
  await handler();

  assert.equal(requestTimeout, 30_000);
  assert.equal(maxExecutionTime, 25);
  assert.equal(meterRuns, 1);
  assert.equal(closes, 1);
});
