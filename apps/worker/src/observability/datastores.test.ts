import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ClickHouseClient } from "@clickhouse/client";
import { loadClickHouseMetrics } from "./datastores.js";

function result(rows: unknown[]) {
  return {
    async json() {
      return rows;
    },
  };
}

test("loadClickHouseMetrics keeps system metrics when query_log is unavailable", async () => {
  const queries: string[] = [];
  const clickhouse = {
    async query({ query }: { query: string }) {
      queries.push(query);
      if (query.includes("system.query_log")) throw new Error("UNKNOWN_TABLE");
      return result([
        { name: "memory_resident_bytes", value: "1024" },
        { name: "active_queries", value: 2 },
      ]);
    },
  } as unknown as Pick<ClickHouseClient, "query">;
  const metrics = await loadClickHouseMetrics(clickhouse);

  assert.equal(queries.length, 2);
  assert.equal(metrics.get("memory_resident_bytes"), 1024);
  assert.equal(metrics.get("active_queries"), 2);
  assert.equal(metrics.has("query_duration_p95_ms"), false);
});
