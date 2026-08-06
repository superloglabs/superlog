import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ClickHouseClient } from "@clickhouse/client";
import { metricSeries } from "./index.js";

test("metric series strips the resource scope from a group key", async () => {
  const queryParams: Record<string, unknown>[] = [];
  const ch = {
    async query(input: { query_params?: Record<string, unknown> }) {
      queryParams.push(input.query_params ?? {});
      return { json: async () => [] };
    },
  } as unknown as ClickHouseClient;

  await metricSeries(
    ch,
    "project-1",
    "requests.total",
    {},
    "resource.deployment.environment",
    { n: 1, unit: "MINUTE" },
    "sum",
  );

  assert.ok(queryParams.length > 0);
  for (const params of queryParams) {
    assert.equal(params.groupKey, "deployment.environment");
  }
});
