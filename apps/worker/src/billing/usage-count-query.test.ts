import assert from "node:assert/strict";
import { test } from "node:test";
import {
  METRIC_TABLES,
  buildUsageCountQueries,
  buildUsageCountQuery,
} from "./usage-count-query.js";

test("log usage counts preserve precise bounds while pruning by TimestampTime", () => {
  const query = buildUsageCountQuery("logs");

  assert.match(query, /Timestamp > \{after:DateTime64\(9\)\}/);
  assert.match(query, /Timestamp <= \{until:DateTime64\(9\)\}/);
  assert.match(query, /TimestampTime >= \{after:DateTime64\(9\)\} - INTERVAL 1 SECOND/);
  assert.match(query, /TimestampTime <= \{until:DateTime64\(9\)\}/);
});

test("metric usage falls back to resource attributes when optimized columns are unavailable", () => {
  const queries = buildUsageCountQueries("metric_points");

  assert.equal(queries.length, 5);
  assert.ok(queries.every((query) => !query.includes("UNION ALL")));
  assert.ok(queries.every((query) => query.includes("PREWHERE TimeUnix")));
  assert.ok(queries.every((query) => query.includes("TimeUnix > {after:DateTime64(9)}")));
  assert.ok(queries.every((query) => query.includes("TimeUnix <= {until:DateTime64(9)}")));
  assert.ok(
    queries.every((query) => query.includes("ResourceAttributes['superlog.project_id'] AS pid")),
  );
  for (const table of METRIC_TABLES) {
    assert.ok(queries.some((query) => query.includes(`FROM ${table}`)));
  }
});

test("metric usage reads the exact-count time projection when its project column exists", () => {
  const queries = buildUsageCountQueries("metric_points", new Set(METRIC_TABLES));

  assert.equal(queries.length, METRIC_TABLES.length);
  assert.ok(queries.every((query) => query.includes("SuperlogProjectId AS pid")));
  assert.ok(queries.every((query) => !query.includes("ResourceAttributes[")));
  assert.ok(queries.every((query) => query.includes("PREWHERE TimeUnix")));
});
