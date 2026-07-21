import assert from "node:assert/strict";
import { test } from "node:test";

import { getHomeSignalSeries, mergeHomeSignalSeriesRows } from "./home-signal-series.js";

test("home signal series merges traces, logs, and metrics into chronological chart points", () => {
  const series = mergeHomeSignalSeriesRows([
    { bucket: "2026-07-21 10:05:00", signal: "logs", count: "14" },
    { bucket: "2026-07-21 10:00:00", signal: "traces", count: 9 },
    { bucket: "2026-07-21 10:00:00", signal: "metrics", count: "21" },
    { bucket: "2026-07-21 10:05:00", signal: "traces", count: 11 },
  ]);

  assert.deepEqual(series, [
    { bucket: "2026-07-21 10:00:00", traces: 9, logs: 0, metrics: 21 },
    { bucket: "2026-07-21 10:05:00", traces: 11, logs: 14, metrics: 0 },
  ]);
});

test("home signal series reads event rollups and metric usage projections", async () => {
  const queries: string[] = [];
  const clickhouse = {
    async query({ query }: { query: string }) {
      queries.push(query);
      return {
        async json() {
          return [];
        },
      };
    },
  };

  await getHomeSignalSeries(
    clickhouse as never,
    "project-1",
    { since: "2026-07-21T09:00:00.000Z", until: "2026-07-21T10:00:00.000Z" },
    { n: 5, unit: "MINUTE" },
  );

  assert.equal(queries.length, 1);
  assert.match(queries[0] ?? "", /FROM events_per_minute/);
  assert.match(queries[0] ?? "", /SuperlogProjectId/);
  assert.doesNotMatch(queries[0] ?? "", /ResourceAttributes/);
});
