import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClickHouseClient } from "@clickhouse/client";
import { METRIC_TABLES } from "./usage-count-query.js";
import { createAutumnTrack, createCountByProject } from "./usage-meter-ticker.js";

test("metric counts probe optimized columns, scan projections sequentially, and merge totals", async () => {
  const queries: string[] = [];
  const querySignals: Array<AbortSignal | undefined> = [];
  const deadline = new AbortController();
  let inFlight = 0;
  let maxInFlight = 0;
  const clickhouse = {
    async query({ query, abort_signal }: { query: string; abort_signal?: AbortSignal }) {
      queries.push(query);
      querySignals.push(abort_signal);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return {
        async json() {
          await new Promise((resolve) => setImmediate(resolve));
          inFlight -= 1;
          if (/FROM system\.columns/.test(query)) {
            return METRIC_TABLES.map((table) => ({ table }));
          }
          return /FROM otel_metrics_sum(?:\s|$)/.test(query)
            ? [
                { pid: "p1", c: 2 },
                { pid: "p2", c: 3 },
              ]
            : [{ pid: "p1", c: 2 }];
        },
      };
    },
  } as unknown as Pick<ClickHouseClient, "query">;

  const count = createCountByProject(clickhouse, deadline.signal);
  const result = await count(
    "metric_points",
    "2026-07-14T10:00:00.000Z",
    "2026-07-14T10:05:00.000Z",
  );

  assert.equal(queries.length, 6);
  assert.ok(querySignals.every((signal) => signal === deadline.signal));
  assert.equal(maxInFlight, 1);
  assert.match(queries[0] ?? "", /FROM system\.columns/);
  assert.match(queries[0] ?? "", /table IN \{tables:Array\(String\)\}/);
  assert.ok(queries.slice(1).every((query) => query.includes("SuperlogProjectId AS pid")));
  assert.deepEqual(
    [...result],
    [
      ["p1", 10],
      ["p2", 3],
    ],
  );
});

test("metric counts retain a resource-attribute fallback for unmodified ClickHouse schemas", async () => {
  const queries: string[] = [];
  const clickhouse = {
    async query({ query }: { query: string }) {
      queries.push(query);
      return {
        async json() {
          if (/FROM system\.columns/.test(query)) return [];
          return [{ pid: "p1", c: 1 }];
        },
      };
    },
  } as unknown as Pick<ClickHouseClient, "query">;

  const result = await createCountByProject(clickhouse)(
    "metric_points",
    "2026-07-14T10:00:00.000Z",
    "2026-07-14T10:05:00.000Z",
  );

  assert.equal(result.get("p1"), 5);
  assert.ok(
    queries
      .slice(1)
      .every((query) => query.includes("ResourceAttributes['superlog.project_id'] AS pid")),
  );
});

test("Autumn requests share the usage job deadline across create-and-retry", async () => {
  const deadline = new AbortController();
  const requestSignals: AbortSignal[] = [];
  const statuses = [404, 200, 200];
  const fetchImpl: typeof fetch = async (_input, init) => {
    requestSignals.push(init?.signal as AbortSignal);
    return new Response(null, { status: statuses.shift() ?? 500 });
  };

  const track = createAutumnTrack("secret", fetchImpl, deadline.signal);
  await track("org-1", "metric_points", 10);

  assert.equal(requestSignals.length, 3);
  assert.ok(requestSignals.every((signal) => !signal.aborted));
  deadline.abort();
  assert.ok(requestSignals.every((signal) => signal.aborted));
});
