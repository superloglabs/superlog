import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClickHouseClient } from "@clickhouse/client";
import { METRIC_TABLES } from "../billing/usage-count-query.js";
import { activeProjectIds } from "./usage-notify.js";

test("active projects use narrow rollups and metric projections without a wide union scan", async () => {
  const queries: string[] = [];
  const clickhouse = {
    async query({ query }: { query: string }) {
      queries.push(query);
      return {
        async json() {
          if (/^EXISTS TABLE events_per_minute/.test(query.trim())) return [{ result: 1 }];
          if (/FROM system\.columns/.test(query)) {
            return METRIC_TABLES.map((table) => ({ table }));
          }
          if (/FROM events_per_minute/.test(query)) {
            return [{ pid: "11111111-1111-4111-8111-111111111111" }, { pid: "not-a-project" }];
          }
          return [{ pid: "22222222-2222-4222-8222-222222222222" }];
        },
      };
    },
  } as unknown as Pick<ClickHouseClient, "query">;

  const result = await activeProjectIds(clickhouse);

  assert.deepEqual(result, [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
  ]);
  assert.ok(queries.some((query) => query.includes("FROM events_per_minute")));
  assert.ok(queries.every((query) => !query.includes("UNION")));
  assert.ok(
    queries
      .filter((query) => /FROM otel_metrics_/.test(query))
      .every((query) => query.includes("SuperlogProjectId AS pid")),
  );
});

test("active projects retain bounded raw-table fallbacks when rollups are unavailable", async () => {
  const queries: string[] = [];
  const clickhouse = {
    async query({ query }: { query: string }) {
      queries.push(query);
      return {
        async json() {
          if (/^EXISTS TABLE events_per_minute/.test(query.trim())) return [{ result: 0 }];
          if (/FROM system\.columns/.test(query)) return [];
          return [];
        },
      };
    },
  } as unknown as Pick<ClickHouseClient, "query">;

  await activeProjectIds(clickhouse);

  const logQuery = queries.find((query) => query.includes("FROM otel_logs"));
  assert.match(logQuery ?? "", /TimestampTime > now\(\) - INTERVAL 30 MINUTE - INTERVAL 1 SECOND/);
  assert.match(logQuery ?? "", /Timestamp <= now64\(9\)/);
  assert.ok(
    queries
      .filter((query) => /FROM otel_metrics_/.test(query))
      .every((query) => query.includes("ResourceAttributes['superlog.project_id'] AS pid")),
  );
});
