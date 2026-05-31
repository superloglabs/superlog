import assert from "node:assert/strict";
import type { ClickHouseClient } from "@clickhouse/client";
import { listServices, queryLogs } from "../src/mcp/clickhouse.js";

type QueryCall = {
  query: string;
  query_params?: Record<string, unknown>;
  format?: string;
};

function fakeClickHouse(calls: QueryCall[]): ClickHouseClient {
  return {
    query: async (args: QueryCall) => {
      calls.push(args);
      return { json: async () => [] };
    },
  } as unknown as ClickHouseClient;
}

function normalizedSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

async function testDefaultRelativeRangeIsExecutableSql() {
  const calls: QueryCall[] = [];
  await queryLogs(fakeClickHouse(calls), "00000000-0000-0000-0000-000000000001", {
    limit: 10,
  });

  const sql = normalizedSql(calls[0]?.query ?? "");
  assert.match(sql, /Timestamp >= now\(\) - INTERVAL 1 HOUR/);
  assert.match(sql, /Timestamp <= now\(\)/);
  assert.doesNotMatch(sql, /parseDateTime64BestEffortOrZero\(\{since:String\}\)/);
  assert.doesNotMatch(sql, /parseDateTime64BestEffortOrZero\(\{until:String\}\)/);
}

async function testExplicitRelativeRangeIsExecutableSql() {
  const calls: QueryCall[] = [];
  await listServices(fakeClickHouse(calls), "00000000-0000-0000-0000-000000000001", {
    since: "now() - INTERVAL 7 DAY",
    until: "now()",
  });

  const sql = normalizedSql(calls[0]?.query ?? "");
  assert.match(sql, /Timestamp >= now\(\) - INTERVAL 7 DAY/);
  assert.match(sql, /Timestamp <= now\(\)/);
  assert.doesNotMatch(sql, /parseDateTime64BestEffortOrZero\(\{since:String\}\)/);
  assert.doesNotMatch(sql, /parseDateTime64BestEffortOrZero\(\{until:String\}\)/);
}

async function testIsoRangeStillUsesParameterizedParsing() {
  const calls: QueryCall[] = [];
  await queryLogs(fakeClickHouse(calls), "00000000-0000-0000-0000-000000000001", {
    range: {
      since: "2026-05-06T13:12:08.771Z",
      until: "2026-05-06T14:12:08.771Z",
    },
    limit: 10,
  });

  const sql = normalizedSql(calls[0]?.query ?? "");
  assert.match(sql, /Timestamp >= parseDateTime64BestEffortOrZero\(\{since:String\}\)/);
  assert.match(sql, /Timestamp <= parseDateTime64BestEffortOrZero\(\{until:String\}\)/);
  assert.equal(calls[0]?.query_params?.since, "2026-05-06T13:12:08.771Z");
  assert.equal(calls[0]?.query_params?.until, "2026-05-06T14:12:08.771Z");
}

await testDefaultRelativeRangeIsExecutableSql();
await testExplicitRelativeRangeIsExecutableSql();
await testIsoRangeStillUsesParameterizedParsing();

console.log("mcp clickhouse range tests passed");
