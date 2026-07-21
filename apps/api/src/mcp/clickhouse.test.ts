import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ClickHouseClient } from "@clickhouse/client";
import {
  countSeries,
  fieldColumnExpr,
  listAttributeKeys,
  listAttributeValues,
  listMetricNames,
  listServices,
  metricAggregate,
  metricSeries,
  queryLogs,
  queryMetrics,
  queryTraces,
  queryTracesAggregated,
} from "./clickhouse.js";

function fakeClickhouse(capture: { query?: string; params?: Record<string, unknown> }) {
  return {
    async query(input: { query: string; query_params?: Record<string, unknown> }) {
      capture.query = input.query;
      capture.params = input.query_params;
      return {
        async json() {
          return [];
        },
      };
    },
  } as unknown as ClickHouseClient;
}

// queryMetrics fans out across all metric tables, so a single-slot capture
// would only retain the last query. This collects every query it runs.
function fakeClickhouseMulti(queries: string[]) {
  return {
    async query(input: { query: string; query_params?: Record<string, unknown> }) {
      queries.push(input.query);
      return {
        async json() {
          return [];
        },
      };
    },
  } as unknown as ClickHouseClient;
}

test("countSeries groups traces by span attributes when groupBy uses attr prefix", async () => {
  const capture: { query?: string; params?: Record<string, unknown> } = {};

  await countSeries(
    fakeClickhouse(capture),
    "project-1",
    "traces",
    { range: { since: "now() - INTERVAL 1 HOUR", until: "now()" } },
    "attr:superlog.endpoint",
    { n: 1, unit: "MINUTE" },
  );

  assert.match(capture.query ?? "", /SpanAttributes\[\{groupKey:String\}\]/);
  assert.equal(capture.params?.groupKey, "superlog.endpoint");
});

test("countSeries groups traces by prefixed span attributes", async () => {
  const capture: { query?: string; params?: Record<string, unknown> } = {};

  await countSeries(
    fakeClickhouse(capture),
    "project-1",
    "traces",
    { range: { since: "now() - INTERVAL 1 HOUR", until: "now()" } },
    "span.session.id",
    { n: 1, unit: "MINUTE" },
  );

  assert.match(capture.query ?? "", /SpanAttributes\[\{groupKey:String\}\]/);
  assert.equal(capture.params?.groupKey, "session.id");
});

test("countSeries groups logs by prefixed log attributes", async () => {
  const capture: { query?: string; params?: Record<string, unknown> } = {};

  await countSeries(
    fakeClickhouse(capture),
    "project-1",
    "logs",
    { range: { since: "now() - INTERVAL 1 HOUR", until: "now()" } },
    "log.session.id",
    { n: 1, unit: "MINUTE" },
  );

  assert.match(capture.query ?? "", /LogAttributes\[\{groupKey:String\}\]/);
  assert.equal(capture.params?.groupKey, "session.id");
});

test("countSeries groups logs by log attributes when groupBy uses attr prefix", async () => {
  const capture: { query?: string; params?: Record<string, unknown> } = {};

  await countSeries(
    fakeClickhouse(capture),
    "project-1",
    "logs",
    { range: { since: "now() - INTERVAL 1 HOUR", until: "now()" } },
    "attr:log.level",
    { n: 1, unit: "MINUTE" },
  );

  assert.match(capture.query ?? "", /LogAttributes\[\{groupKey:String\}\]/);
  assert.equal(capture.params?.groupKey, "log.level");
});

test("listAttributeKeys includes prefixed span attributes for trace exploration", async () => {
  const capture: { query?: string; params?: Record<string, unknown> } = {};

  await listAttributeKeys(
    fakeClickhouse(capture),
    "project-1",
    { since: "now() - INTERVAL 1 HOUR", until: "now()" },
    "traces",
  );

  assert.match(capture.query ?? "", /mapKeys\(ResourceAttributes\)/);
  assert.match(capture.query ?? "", /mapKeys\(SpanAttributes\)/);
  assert.match(capture.query ?? "", /concat\('span\.', k\)/);
});

test("listAttributeKeys caps the rows scanned per source so high-volume projects don't time out", async () => {
  const capture: { query?: string; params?: Record<string, unknown> } = {};

  await listAttributeKeys(
    fakeClickhouse(capture),
    "project-1",
    { since: "now() - INTERVAL 1 HOUR", until: "now()" },
    "traces",
  );

  // Each per-source key scan reads at most ATTRIBUTE_KEY_SCAN_ROW_CAP rows
  // before arrayJoin/group, so the query stays ~1s instead of 15-30s.
  const limitMatches = (capture.query ?? "").match(/LIMIT 1000000/g) ?? [];
  // resource.* from traces + span.* from traces = two capped scans.
  assert.equal(limitMatches.length, 2);
});

test("listAttributeValues resolves prefixed span attributes", async () => {
  const capture: { query?: string; params?: Record<string, unknown> } = {};

  await listAttributeValues(
    fakeClickhouse(capture),
    "project-1",
    "span.session.id",
    { since: "now() - INTERVAL 1 HOUR", until: "now()" },
    200,
    "traces",
  );

  assert.match(capture.query ?? "", /SpanAttributes\[\{key:String\}\]/);
  assert.equal(capture.params?.key, "session.id");
});

test("queryTraces filters by prefixed span attributes", async () => {
  const capture: { query?: string; params?: Record<string, unknown> } = {};

  await queryTraces(fakeClickhouse(capture), "project-1", {
    range: { since: "now() - INTERVAL 1 HOUR", until: "now()" },
    resourceAttrs: [{ key: "span.session.id", value: "s1" }],
    limit: 50,
  });

  assert.match(
    capture.query ?? "",
    /SpanAttributes\[\{sattr_k_0:String\}\] = \{sattr_v_0:String\}/,
  );
  assert.equal(capture.params?.sattr_k_0, "session.id");
  assert.equal(capture.params?.sattr_v_0, "s1");
});

test("telemetry queries reject malformed time bounds before querying ClickHouse", async () => {
  const capture: { query?: string; params?: Record<string, unknown> } = {};

  await assert.rejects(
    queryTraces(fakeClickhouse(capture), "project-1", {
      range: { since: "last 24 hours", until: "now()" },
      limit: 50,
    }),
    /invalid since time bound/i,
  );

  assert.equal(capture.query, undefined);
});

test("telemetry queries preserve space-separated saved-view time bounds", async () => {
  const capture: { query?: string; params?: Record<string, unknown> } = {};

  await queryTraces(fakeClickhouse(capture), "project-1", {
    range: { since: "2026-06-26 02:40:00", until: "2026-06-26 03:40:00" },
    limit: 50,
  });

  assert.match(capture.query ?? "", /parseDateTime64BestEffortOrZero/);
  assert.equal(capture.params?.since, "2026-06-26 02:40:00");
  assert.equal(capture.params?.until, "2026-06-26 03:40:00");
});

test("listServices discovers services across traces, logs, and metrics", async () => {
  const queriedTables: string[] = [];
  const queriesByTable: Record<string, string> = {};
  const servicesByTable: Record<string, string[]> = {
    otel_traces: ["api"],
    otel_logs: ["api", "log-only-worker"],
    otel_metrics_gauge: ["metric-only-cron"],
    otel_metrics_sum: [],
    otel_metrics_histogram: ["api"],
    otel_metrics_exp_histogram: ["exp-histogram-only"],
  };
  const ch = {
    async query(input: { query: string }) {
      const table = input.query.match(/FROM\s+(otel_[a-z_]+)/i)?.[1];
      assert.ok(table);
      queriedTables.push(table);
      queriesByTable[table] = input.query;
      if (table === "otel_metrics_summary") throw new Error("UNKNOWN_TABLE");
      return {
        async json() {
          return (servicesByTable[table] ?? []).map((service) => ({ service }));
        },
      };
    },
  } as unknown as ClickHouseClient;

  const services = await listServices(ch, "project-1", {
    since: "now() - INTERVAL 1 HOUR",
    until: "now()",
  });

  assert.deepEqual(services, ["api", "exp-histogram-only", "log-only-worker", "metric-only-cron"]);
  assert.deepEqual(queriedTables.sort(), [
    "otel_logs",
    "otel_metrics_exp_histogram",
    "otel_metrics_gauge",
    "otel_metrics_histogram",
    "otel_metrics_sum",
    "otel_metrics_summary",
    "otel_traces",
  ]);
  const logQuery = queriesByTable.otel_logs;
  assert.ok(logQuery);
  assert.match(logQuery, /TimestampTime >= \(now\(\) - INTERVAL 1 HOUR\) - INTERVAL 1 SECOND/);
  assert.match(logQuery, /TimestampTime <= now\(\)/);
});

test("fieldColumnExpr allowlists identifier columns per source", () => {
  assert.equal(fieldColumnExpr("trace_id", "logs"), "TraceId");
  assert.equal(fieldColumnExpr("span_id", "logs"), "SpanId");
  assert.equal(fieldColumnExpr("severity_number", "logs"), "toString(SeverityNumber)");
  assert.equal(fieldColumnExpr("trace_id", "traces"), "TraceId");
  assert.equal(fieldColumnExpr("severity_number", "traces"), null);
  assert.equal(fieldColumnExpr("unknown", "logs"), null);
});

test("queryLogs filters by field.trace_id against the TraceId column", async () => {
  const capture: { query?: string; params?: Record<string, unknown> } = {};

  await queryLogs(fakeClickhouse(capture), "project-1", {
    range: { since: "now() - INTERVAL 1 HOUR", until: "now()" },
    resourceAttrs: [{ key: "field.trace_id", value: "abc123" }],
    limit: 50,
  });

  assert.match(capture.query ?? "", /TraceId = \{fattr_v_0:String\}/);
  assert.equal(capture.params?.fattr_v_0, "abc123");
});

test("queryLogs filters by field.severity_number via a string-cast column", async () => {
  const capture: { query?: string; params?: Record<string, unknown> } = {};

  await queryLogs(fakeClickhouse(capture), "project-1", {
    range: { since: "now() - INTERVAL 1 HOUR", until: "now()" },
    resourceAttrs: [{ key: "field.severity_number", value: "9" }],
    limit: 50,
  });

  assert.match(capture.query ?? "", /toString\(SeverityNumber\) = \{fattr_v_0:String\}/);
  assert.equal(capture.params?.fattr_v_0, "9");
});

// queryTracesAggregated first probes `EXISTS TABLE otel_traces_recent` /
// `otel_traces_summary`, then runs a coverage probe (`count() AS c` over the
// recent index older than the window start), and only then either runs the
// two-step fast path or falls back to the raw otel_traces scan. This fake answers
// the EXISTS probes and the coverage probe with fixed results and captures the
// final (real) query so tests can assert which path was taken.
function fakeClickhouseWithSummary(
  capture: { query?: string; params?: Record<string, unknown> },
  derivedTablesExist: boolean,
  windowCovered = true,
) {
  return {
    async query(input: { query: string; query_params?: Record<string, unknown> }) {
      if (/EXISTS TABLE/i.test(input.query)) {
        return {
          async json() {
            return [{ result: derivedTablesExist ? 1 : 0 }];
          },
        };
      }
      if (/count\(\) AS c/i.test(input.query)) {
        return {
          async json() {
            return [{ c: windowCovered ? 1 : 0 }];
          },
        };
      }
      capture.query = input.query;
      capture.params = input.query_params;
      return {
        async json() {
          return [];
        },
      };
    },
  } as unknown as ClickHouseClient;
}

test("queryTracesAggregated runs the two-step fast path when the derived tables exist, cover the window, and no filter is set", async () => {
  const capture: { query?: string; params?: Record<string, unknown> } = {};

  await queryTracesAggregated(fakeClickhouseWithSummary(capture, true), "project-1", {
    range: { since: "now() - INTERVAL 24 HOUR", until: "now()" },
    limit: 100,
  });

  // Step 1: recent-trace-id index. Step 2: per-trace stats from the summary.
  assert.match(capture.query ?? "", /WITH recent_ids AS/);
  assert.match(capture.query ?? "", /FROM otel_traces_recent/);
  assert.match(capture.query ?? "", /FROM otel_traces_summary/);
  assert.match(capture.query ?? "", /trace_id IN \(recent_ids\)/);
  assert.match(capture.query ?? "", /argMinMerge\(root_span_name\)/);
  assert.match(capture.query ?? "", /uniqExactMerge\(services\)/);
  // The bare raw-scan table must not appear (otel_traces_recent/_summary are ok).
  assert.doesNotMatch(capture.query ?? "", /FROM otel_traces\b/);
  assert.equal(capture.params?.projectId, "project-1");
  assert.equal(capture.params?.limit, 100);
});

test("queryTracesAggregated falls back to the raw scan when a minDuration floor is set", async () => {
  const capture: { query?: string; params?: Record<string, unknown> } = {};

  await queryTracesAggregated(fakeClickhouseWithSummary(capture, true), "project-1", {
    range: { since: "now() - INTERVAL 24 HOUR", until: "now()" },
    minDurationMs: 250,
    limit: 100,
  });

  // A duration floor can exclude more traces than the recent window holds, so it
  // needs the raw table rather than the recent-then-summary fast path.
  assert.match(capture.query ?? "", /FROM otel_traces\b/);
  assert.doesNotMatch(capture.query ?? "", /recent_ids/);
});

test("queryTracesAggregated falls back to the raw scan when a span-level filter is set", async () => {
  const capture: { query?: string; params?: Record<string, unknown> } = {};

  await queryTracesAggregated(fakeClickhouseWithSummary(capture, true), "project-1", {
    range: { since: "now() - INTERVAL 24 HOUR", until: "now()" },
    service: "svc-web",
    limit: 100,
  });

  // A service filter selects traces by their spans; the summary can't answer it.
  assert.match(capture.query ?? "", /FROM otel_traces\b/);
  assert.doesNotMatch(capture.query ?? "", /otel_traces_summary/);
});

test("queryTracesAggregated falls back to the raw scan when the derived tables are absent", async () => {
  const capture: { query?: string; params?: Record<string, unknown> } = {};

  await queryTracesAggregated(fakeClickhouseWithSummary(capture, false), "project-1", {
    range: { since: "now() - INTERVAL 24 HOUR", until: "now()" },
    limit: 100,
  });

  assert.match(capture.query ?? "", /FROM otel_traces\b/);
  assert.doesNotMatch(capture.query ?? "", /otel_traces_summary/);
});

test("queryTracesAggregated re-probes and picks up the rollup after the tables appear (no stale 'absent' cache)", async () => {
  // A negative EXISTS result must not be cached forever: the derived tables are
  // created by a migration that can land after the process boots. `state` flips
  // from absent to present between the two calls on the SAME client.
  const state = { present: false };
  const capture: { query?: string; params?: Record<string, unknown> } = {};
  const ch = {
    async query(input: { query: string; query_params?: Record<string, unknown> }) {
      if (/EXISTS TABLE/i.test(input.query)) {
        return {
          async json() {
            return [{ result: state.present ? 1 : 0 }];
          },
        };
      }
      if (/count\(\) AS c/i.test(input.query)) {
        return {
          async json() {
            return [{ c: 1 }];
          },
        };
      }
      capture.query = input.query;
      capture.params = input.query_params;
      return {
        async json() {
          return [];
        },
      };
    },
  } as unknown as ClickHouseClient;

  const filter = { range: { since: "now() - INTERVAL 24 HOUR", until: "now()" }, limit: 100 };
  await queryTracesAggregated(ch, "project-1", filter);
  assert.match(capture.query ?? "", /FROM otel_traces\b/); // absent → raw

  state.present = true;
  await queryTracesAggregated(ch, "project-1", filter);
  assert.match(capture.query ?? "", /recent_ids/); // now present → fast path
});

test("queryTracesAggregated falls back to the raw scan when the rollup does not yet cover the window", async () => {
  const capture: { query?: string; params?: Record<string, unknown> } = {};

  // Tables exist, but the recent index has no row older than the window start
  // (e.g. before the historical backfill runs) — using the fast path would
  // silently truncate the list to post-migration data, so fall back to raw.
  await queryTracesAggregated(fakeClickhouseWithSummary(capture, true, false), "project-1", {
    range: { since: "now() - INTERVAL 24 HOUR", until: "now()" },
    limit: 100,
  });

  assert.match(capture.query ?? "", /FROM otel_traces\b/);
  assert.doesNotMatch(capture.query ?? "", /recent_ids/);
});

test("queryTraces filters by field.span_id, ignoring non-applicable field keys", async () => {
  const capture: { query?: string; params?: Record<string, unknown> } = {};

  await queryTraces(fakeClickhouse(capture), "project-1", {
    range: { since: "now() - INTERVAL 1 HOUR", until: "now()" },
    resourceAttrs: [
      { key: "field.span_id", value: "span-9" },
      { key: "field.severity_number", value: "9" },
    ],
    limit: 50,
  });

  assert.match(capture.query ?? "", /SpanId = \{fattr_v_0:String\}/);
  assert.equal(capture.params?.fattr_v_0, "span-9");
  // severity_number isn't a traces column, so it must not produce a condition.
  assert.doesNotMatch(capture.query ?? "", /SeverityNumber/);
});

test("metricSeries can exclude resource attributes by substring", async () => {
  const capture: { query?: string; params?: Record<string, unknown> } = {};

  await metricSeries(
    fakeClickhouse(capture),
    "project-1",
    "superlog.worker.cursor_lag_ms",
    {
      range: { since: "now() - INTERVAL 1 HOUR", until: "now()" },
      resourceAttrs: [{ key: "host.name", value: ".local", op: "not_contains" }],
    },
    undefined,
    { n: 1, unit: "MINUTE" },
    "max",
  );

  assert.match(
    capture.query ?? "",
    /positionCaseInsensitive\(ResourceAttributes\[\{attr_k_0:String\}\], \{attr_v_0:String\}\) = 0/,
  );
  assert.equal(capture.params?.attr_k_0, "host.name");
  assert.equal(capture.params?.attr_v_0, ".local");
});

test("metricSeries spreads cumulative monotonic sum increases across the interval each sample covers", async () => {
  const queries: string[] = [];

  await metricSeries(
    fakeClickhouseMulti(queries),
    "project-1",
    "superlog.proxy.ingest.requests",
    { range: { since: "now() - INTERVAL 1 HOUR", until: "now()" } },
    "attr:tenant.org.name",
    { n: 1, unit: "MINUTE" },
    "sum",
  );

  const sumQuery = queries.find((q) => q.includes("FROM otel_metrics_sum"));
  assert.ok(sumQuery, "expected a sum metric query");
  assert.match(sumQuery, /AggregationTemporality = 2/);
  assert.match(sumQuery, /IsMonotonic/);
  // Per-sample increase from cumulative values, including one predecessor
  // before the requested boundary.
  assert.match(sumQuery, /lagInFrame\(toNullable\(TemporalityValue\), 1, NULL\)/);
  assert.match(sumQuery, /TemporalityValue - previous_value/);
  assert.match(sumQuery, /TimeUnix < now\(\) - INTERVAL 1 HOUR/);
  // The increase is spread over the wall-clock interval (prev sample -> this
  // sample) by weighting each render bucket's overlap with that interval —
  // this is what removes the "comb" when the step is finer than the export
  // interval. Needs the previous sample's timestamp and an overlap weight.
  assert.match(sumQuery, /lagInFrame\(TimeUnix, 1, TimeUnix\)/);
  assert.match(sumQuery, /ARRAY JOIN spread/);
  // Interval math is in nanoseconds (1 MINUTE step = 60e9 ns) so sub-second
  // sample intervals aren't quantized away.
  assert.match(sumQuery, /toUnixTimestamp64Nano\(prev_time\)/);
  assert.match(sumQuery, /least\(b, g \+ 60000000000\) - greatest\(a, g, toUnixTimestamp64Nano\(/);
  assert.match(sumQuery, /\/ dt/);
  // Delta points use their declared start/end interval and are spread through
  // the same bucket-overlap path.
  assert.match(sumQuery, /AggregationTemporality = 1/);
  assert.match(sumQuery, /toUnixTimestamp64Nano\(StartTimeUnix\) AS a/);
  // Scope and resource identity are part of the cumulative stream key, so two
  // distinct producers cannot be differenced against each other.
  assert.match(sumQuery, /ScopeName/);
  assert.match(sumQuery, /ScopeVersion/);
  assert.match(sumQuery, /ScopeAttributes/);
  assert.match(sumQuery, /ResourceAttributes/);
  assert.match(sumQuery, /Attributes\[\{groupKey:String\}\] AS group_key/);
  assert.equal(queries.length, 5);
});

test("metricAggregate caps groups without capping time-series bucket rows", async () => {
  const queries: string[] = [];

  await metricAggregate(
    fakeClickhouseMulti(queries),
    "project-1",
    "superlog.proxy.ingest.requests",
    { range: { since: "now() - INTERVAL 1 DAY", until: "now()" } },
    "service.name",
    "sum",
  );

  const sumQuery = queries.find((q) => q.includes("FROM otel_metrics_sum"));
  assert.ok(sumQuery, "expected a sum metric query");
  assert.match(sumQuery, /LIMIT 1000/);
  assert.doesNotMatch(sumQuery, /LIMIT 10000/);
  assert.match(sumQuery, /toUnixTimestamp64Nano\(now\(\) - INTERVAL 1 DAY\)/);
});

test("queryTraces returns resource attributes and flattened exception fields", async () => {
  const capture: { query?: string; params?: Record<string, unknown> } = {};

  await queryTraces(fakeClickhouse(capture), "project-1", {
    range: { since: "now() - INTERVAL 1 HOUR", until: "now()" },
    limit: 50,
  });

  assert.match(capture.query ?? "", /SpanAttributes AS span_attrs/);
  assert.match(capture.query ?? "", /ResourceAttributes AS resource_attrs/);
  assert.match(capture.query ?? "", /AS exception_type/);
  assert.match(capture.query ?? "", /AS exception_message/);
  assert.match(capture.query ?? "", /AS exception_stacktrace/);
});

// Tracks how many queries are in flight at once so tests can assert that a
// fan-out across all metric tables actually runs concurrently instead of
// awaiting each table before starting the next.
function fakeClickhouseConcurrent(state: { inFlight: number; maxInFlight: number }) {
  return {
    async query() {
      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      state.inFlight -= 1;
      return {
        async json() {
          return [];
        },
      };
    },
  } as unknown as ClickHouseClient;
}

// Like fakeClickhouseWithSummary, but for the metric-names rollup: answers the
// EXISTS probe and the coverage probe, captures the real query, and returns
// canned rollup rows so kind mapping / ordering can be asserted.
function fakeClickhouseMetricNamesRollup(
  capture: { query?: string; params?: Record<string, unknown> },
  rollupExists = true,
  windowCovered = true,
  // Mirrors the real ClickHouse response: the rollup query aliases `sum(c) AS
  // total`, so rows come back keyed by `total`, which is what
  // listMetricNamesFromRollup sorts on within a kind.
  rows: { kind: string; name: string; unit: string; total: number }[] = [],
  exponentialHistogramRows: { name: string; unit: string; c: number }[] = [],
) {
  return {
    async query(input: { query: string; query_params?: Record<string, unknown> }) {
      if (/^EXISTS TABLE/i.test(input.query.trim())) {
        return {
          async json() {
            return [{ result: rollupExists ? 1 : 0 }];
          },
        };
      }
      if (/count\(\) AS c/i.test(input.query) && /FROM \(/.test(input.query)) {
        return {
          async json() {
            return [{ c: windowCovered ? 1 : 0 }];
          },
        };
      }
      if (/FROM otel_metrics_exp_histogram/.test(input.query)) {
        return {
          async json() {
            return exponentialHistogramRows;
          },
        };
      }
      capture.query = input.query;
      capture.params = input.query_params;
      return {
        async json() {
          return rows;
        },
      };
    },
  } as unknown as ClickHouseClient;
}

test("listMetricNames supplements the legacy rollup with exponential histograms", async () => {
  const capture: { query?: string; params?: Record<string, unknown> } = {};

  const names = await listMetricNames(
    // Two "sum" names with differing totals so the within-kind frequency sort
    // (Number(b.total) - Number(a.total)) is actually exercised, not just the
    // primary kind ordering. ClickHouse can return them in any order, so seed
    // them low-then-high to prove the sort flips them.
    fakeClickhouseMetricNamesRollup(
      capture,
      true,
      true,
      [
        { kind: "sum", name: "http.retries", unit: "1", total: 12 },
        { kind: "sum", name: "http.requests", unit: "1", total: 500 },
        { kind: "gauge", name: "process.memory", unit: "By", total: 100 },
        { kind: "bogus", name: "ignored", unit: "", total: 1 },
      ],
      [{ name: "http.duration.exp", unit: "ms", c: 7 }],
    ),
    "project-1",
    { since: "now() - INTERVAL 24 HOUR", until: "now()" },
  );

  assert.match(capture.query ?? "", /FROM metric_names_per_hour/);
  assert.match(capture.query ?? "", /sum\(c\)/);
  // the partial first hour rounds down to its cell boundary so it is included
  assert.match(capture.query ?? "", /hour >= toStartOfHour\(/);
  assert.equal(capture.params?.projectId, "project-1");
  // Rows come back in METRIC_TABLES kind order; within a kind, most frequent
  // first (http.requests before http.retries); unknown kinds are dropped.
  assert.deepEqual(names, [
    { name: "process.memory", kind: "gauge", unit: "By" },
    { name: "http.requests", kind: "sum", unit: "1" },
    { name: "http.retries", kind: "sum", unit: "1" },
    { name: "http.duration.exp", kind: "exponential_histogram", unit: "ms" },
  ]);
});

test("listMetricNames keeps the rollup result when the exponential histogram table is absent", async () => {
  const names = await listMetricNames(
    {
      async query(input: { query: string }) {
        if (/^EXISTS TABLE/i.test(input.query.trim())) {
          return {
            async json() {
              return [{ result: 1 }];
            },
          };
        }
        if (/count\(\) AS c/i.test(input.query) && /FROM \(/.test(input.query)) {
          return {
            async json() {
              return [{ c: 1 }];
            },
          };
        }
        if (/FROM otel_metrics_exp_histogram/.test(input.query)) {
          throw new Error("Unknown table expression identifier 'otel_metrics_exp_histogram'");
        }
        return {
          async json() {
            return [{ kind: "sum", name: "http.requests", unit: "1", total: 5 }];
          },
        };
      },
    } as unknown as ClickHouseClient,
    "project-1",
    { since: "now() - INTERVAL 24 HOUR", until: "now()" },
  );

  assert.deepEqual(names, [{ name: "http.requests", kind: "sum", unit: "1" }]);
});

test("listMetricNames falls back to the raw tables when the rollup is absent", async () => {
  const queries: string[] = [];

  await listMetricNames(
    {
      async query(input: { query: string }) {
        if (/^EXISTS TABLE/i.test(input.query.trim())) {
          return {
            async json() {
              return [{ result: 0 }];
            },
          };
        }
        queries.push(input.query);
        return {
          async json() {
            return [];
          },
        };
      },
    } as unknown as ClickHouseClient,
    "project-1",
    { since: "now() - INTERVAL 24 HOUR", until: "now()" },
  );

  assert.equal(queries.length, 5);
  for (const q of queries) assert.match(q, /FROM otel_metrics_/);
});

test("listMetricNames falls back to the raw tables when the rollup does not cover the window", async () => {
  const capture: { query?: string; params?: Record<string, unknown> } = {};

  await listMetricNames(fakeClickhouseMetricNamesRollup(capture, true, false), "project-1", {
    since: "now() - INTERVAL 24 HOUR",
    until: "now()",
  });

  assert.match(capture.query ?? "", /FROM otel_metrics_/);
  assert.doesNotMatch(capture.query ?? "", /FROM metric_names_per_hour/);
});

test("listMetricNames raw fallback queries all metric tables concurrently", async () => {
  const state = { inFlight: 0, maxInFlight: 0 };

  await listMetricNames(
    {
      async query(input: { query: string }) {
        if (/^EXISTS TABLE/i.test(input.query.trim())) {
          return {
            async json() {
              return [{ result: 0 }];
            },
          };
        }
        state.inFlight += 1;
        state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        state.inFlight -= 1;
        return {
          async json() {
            return [];
          },
        };
      },
    } as unknown as ClickHouseClient,
    "project-1",
    { since: "now() - INTERVAL 24 HOUR", until: "now()" },
  );

  assert.equal(state.maxInFlight, 5);
});

test("queryMetrics queries all metric tables concurrently", async () => {
  const state = { inFlight: 0, maxInFlight: 0 };

  await queryMetrics(fakeClickhouseConcurrent(state), "project-1", {
    range: { since: "now() - INTERVAL 1 HOUR", until: "now()" },
    limit: 100,
  });

  assert.equal(state.maxInFlight, 5);
});

test("metricSeries queries the metric tables concurrently", async () => {
  const state = { inFlight: 0, maxInFlight: 0 };

  await metricSeries(
    fakeClickhouseConcurrent(state),
    "project-1",
    "http.server.duration",
    { range: { since: "now() - INTERVAL 1 HOUR", until: "now()" } },
    undefined,
    { n: 1, unit: "MINUTE" },
    "avg",
  );

  assert.equal(state.maxInFlight, 5);
});

test("queryMetrics returns data-point attributes for every metric kind", async () => {
  const queries: string[] = [];

  await queryMetrics(fakeClickhouseMulti(queries), "project-1", {
    range: { since: "now() - INTERVAL 1 HOUR", until: "now()" },
    limit: 100,
  });

  assert.equal(queries.length, 5);
  for (const q of queries) {
    assert.match(q, /Attributes AS attributes/);
    assert.match(q, /ResourceAttributes AS resource_attrs/);
  }
});

test("queryMetrics surfaces sum/min/max for histogram points", async () => {
  const queries: string[] = [];

  await queryMetrics(fakeClickhouseMulti(queries), "project-1", {
    range: { since: "now() - INTERVAL 1 HOUR", until: "now()" },
    limit: 100,
  });

  const histogramQuery = queries.find((q) => q.includes("'histogram' AS kind"));
  assert.ok(histogramQuery, "expected a histogram query");
  assert.match(histogramQuery, /Count AS count/);
  assert.match(histogramQuery, /Sum AS sum/);
  assert.match(histogramQuery, /Min AS min/);
  assert.match(histogramQuery, /Max AS max/);

  const gaugeQuery = queries.find((q) => q.includes("'gauge' AS kind"));
  assert.ok(gaugeQuery, "expected a gauge query");
  assert.match(gaugeQuery, /Value AS value/);
});

// -----------------------------------------------------------------------------
// countSeries rollup fast path: minute-or-coarser, rollup-coverable queries
// should read the events_per_minute summing table instead of scanning raw
// otel_traces / otel_logs.
// -----------------------------------------------------------------------------

// Like fakeClickhouse, but answers the rollup availability probe so the fast
// path is reachable. Captures the last non-probe query.
function fakeClickhouseRollup(
  capture: { query?: string; params?: Record<string, unknown> },
  rollupExists = true,
) {
  return {
    async query(input: { query: string; query_params?: Record<string, unknown> }) {
      if (/^EXISTS TABLE/i.test(input.query.trim())) {
        return {
          async json() {
            return [{ result: rollupExists ? 1 : 0 }];
          },
        };
      }
      capture.query = input.query;
      capture.params = input.query_params;
      return {
        async json() {
          return [];
        },
      };
    },
  } as unknown as ClickHouseClient;
}

const HOUR_RANGE = { since: "now() - INTERVAL 24 HOUR", until: "now()" };

test("countSeries reads the events_per_minute rollup for unfiltered minute-step queries", async () => {
  const capture: { query?: string; params?: Record<string, unknown> } = {};

  await countSeries(
    fakeClickhouseRollup(capture),
    "project-1",
    "traces",
    { range: HOUR_RANGE },
    undefined,
    {
      n: 15,
      unit: "MINUTE",
    },
  );

  assert.match(capture.query ?? "", /FROM events_per_minute/);
  assert.match(capture.query ?? "", /sum\(c\)/);
  // sub-minute `since` values round down to the cell boundary so the partial
  // first minute is included rather than dropped
  assert.match(capture.query ?? "", /minute >= toStartOfMinute\(/);
  assert.doesNotMatch(capture.query ?? "", /FROM otel_traces/);
  assert.equal(capture.params?.signal, "traces");
});

test("countSeries re-probes rollup availability after a failed probe", async () => {
  const capture: { query?: string; params?: Record<string, unknown> } = {};
  let probes = 0;
  const ch = {
    async query(input: { query: string; query_params?: Record<string, unknown> }) {
      if (/^EXISTS TABLE/i.test(input.query.trim())) {
        probes += 1;
        if (probes === 1) throw new Error("clickhouse unreachable");
        return {
          async json() {
            return [{ result: 1 }];
          },
        };
      }
      capture.query = input.query;
      capture.params = input.query_params;
      return {
        async json() {
          return [];
        },
      };
    },
  } as unknown as ClickHouseClient;

  // first call: probe fails -> raw scan
  await countSeries(ch, "project-1", "traces", { range: HOUR_RANGE }, undefined, {
    n: 15,
    unit: "MINUTE",
  });
  assert.match(capture.query ?? "", /FROM otel_traces/);

  // second call on the same client: probe retried -> rollup
  await countSeries(ch, "project-1", "traces", { range: HOUR_RANGE }, undefined, {
    n: 15,
    unit: "MINUTE",
  });
  assert.equal(probes, 2);
  assert.match(capture.query ?? "", /FROM events_per_minute/);
});

test("countSeries rollup path supports grouping by service", async () => {
  const capture: { query?: string; params?: Record<string, unknown> } = {};

  await countSeries(
    fakeClickhouseRollup(capture),
    "project-1",
    "logs",
    { range: HOUR_RANGE },
    "service.name",
    {
      n: 1,
      unit: "HOUR",
    },
  );

  assert.match(capture.query ?? "", /FROM events_per_minute/);
  assert.match(capture.query ?? "", /service AS group_key/);
  assert.equal(capture.params?.signal, "logs");
});

test("countSeries rollup path covers service, severity and status filters", async () => {
  const logCapture: { query?: string; params?: Record<string, unknown> } = {};
  await countSeries(
    fakeClickhouseRollup(logCapture),
    "project-1",
    "logs",
    { range: HOUR_RANGE, service: "api", severity: "error" },
    undefined,
    { n: 5, unit: "MINUTE" },
  );
  assert.match(logCapture.query ?? "", /FROM events_per_minute/);
  assert.match(logCapture.query ?? "", /service = \{service:String\}/);
  assert.match(logCapture.query ?? "", /severity = upper\(\{severity:String\}\)/);

  const traceCapture: { query?: string; params?: Record<string, unknown> } = {};
  await countSeries(
    fakeClickhouseRollup(traceCapture),
    "project-1",
    "traces",
    { range: HOUR_RANGE, statusCode: "Error" },
    undefined,
    { n: 5, unit: "MINUTE" },
  );
  assert.match(traceCapture.query ?? "", /FROM events_per_minute/);
  assert.match(traceCapture.query ?? "", /status_code = \{statusCode:String\}/);
});

test("countSeries falls back to the raw table for filters the rollup cannot answer", async () => {
  const cases: { source: "logs" | "traces"; filter: Record<string, unknown>; groupBy?: string }[] =
    [
      {
        source: "traces",
        filter: { range: HOUR_RANGE, resourceAttrs: [{ key: "env", value: "prod", op: "eq" }] },
      },
      { source: "logs", filter: { range: HOUR_RANGE, search: "boom" } },
      { source: "traces", filter: { range: HOUR_RANGE, spanName: "GET /" } },
      { source: "traces", filter: { range: HOUR_RANGE, minDurationMs: 250 } },
      { source: "traces", filter: { range: HOUR_RANGE }, groupBy: "attr:http.route" },
    ];
  for (const c of cases) {
    const capture: { query?: string; params?: Record<string, unknown> } = {};
    await countSeries(fakeClickhouseRollup(capture), "project-1", c.source, c.filter, c.groupBy, {
      n: 1,
      unit: "MINUTE",
    });
    assert.match(
      capture.query ?? "",
      c.source === "logs" ? /FROM otel_logs/ : /FROM otel_traces/,
      `expected raw scan for ${JSON.stringify(c)}`,
    );
  }
});

test("countSeries falls back to the raw table for sub-minute steps", async () => {
  const capture: { query?: string; params?: Record<string, unknown> } = {};

  await countSeries(
    fakeClickhouseRollup(capture),
    "project-1",
    "traces",
    { range: HOUR_RANGE },
    undefined,
    {
      n: 30,
      unit: "SECOND",
    },
  );

  assert.match(capture.query ?? "", /FROM otel_traces/);
});

// -----------------------------------------------------------------------------
// service.name attribute filters should hit the native ServiceName column
// (the tables' primary key starts with ServiceName) instead of the
// ResourceAttributes map, which forces a full-window scan.
// -----------------------------------------------------------------------------

test("countSeries maps a service.name resource filter to the ServiceName column", async () => {
  const capture: { query?: string; params?: Record<string, unknown> } = {};

  await countSeries(
    fakeClickhouse(capture),
    "project-1",
    "logs",
    {
      range: HOUR_RANGE,
      resourceAttrs: [
        { key: "service.name", value: "worker", op: "eq" },
        { key: "env", value: "prod", op: "eq" },
      ],
    },
    undefined,
    { n: 1, unit: "MINUTE" },
  );

  assert.match(capture.query ?? "", /ServiceName = \{attr_v_0:String\}/);
  assert.doesNotMatch(capture.query ?? "", /ResourceAttributes\[\{attr_k_0:String\}\]/);
  // the other attribute still goes through the map
  assert.match(capture.query ?? "", /ResourceAttributes\[\{attr_k_1:String\}\]/);
  assert.equal(capture.params?.attr_v_0, "worker");
});

test("countSeries maps negated service.name filters onto ServiceName too", async () => {
  const neqCapture: { query?: string; params?: Record<string, unknown> } = {};
  await countSeries(
    fakeClickhouse(neqCapture),
    "project-1",
    "traces",
    {
      range: HOUR_RANGE,
      resourceAttrs: [{ key: "resource.service.name", value: "worker", op: "neq" }],
    },
    undefined,
    { n: 1, unit: "MINUTE" },
  );
  assert.match(neqCapture.query ?? "", /ServiceName != \{attr_v_0:String\}/);

  const ncCapture: { query?: string; params?: Record<string, unknown> } = {};
  await countSeries(
    fakeClickhouse(ncCapture),
    "project-1",
    "traces",
    {
      range: HOUR_RANGE,
      resourceAttrs: [{ key: "service.name", value: "work", op: "not_contains" }],
    },
    undefined,
    { n: 1, unit: "MINUTE" },
  );
  assert.match(
    ncCapture.query ?? "",
    /positionCaseInsensitive\(ServiceName, \{attr_v_0:String\}\) = 0/,
  );
});

test("queryLogs maps a service.name resource filter to the ServiceName column", async () => {
  const capture: { query?: string; params?: Record<string, unknown> } = {};

  await queryLogs(fakeClickhouse(capture), "project-1", {
    range: { since: "now() - INTERVAL 1 HOUR", until: "now()" },
    resourceAttrs: [{ key: "service.name", value: "worker", op: "eq" }],
    limit: 50,
  });

  assert.match(capture.query ?? "", /ServiceName = \{attr_v_0:String\}/);
  assert.doesNotMatch(capture.query ?? "", /ResourceAttributes\[\{attr_k_0:String\}\]/);
});

test("countSeries treats a lone service.name equality filter as rollup-coverable", async () => {
  const capture: { query?: string; params?: Record<string, unknown> } = {};

  await countSeries(
    fakeClickhouseRollup(capture),
    "project-1",
    "traces",
    { range: HOUR_RANGE, resourceAttrs: [{ key: "service.name", value: "worker", op: "eq" }] },
    undefined,
    { n: 15, unit: "MINUTE" },
  );

  assert.match(capture.query ?? "", /FROM events_per_minute/);
  assert.match(capture.query ?? "", /service = \{service:String\}/);
  assert.equal(capture.params?.service, "worker");
});

test("countSeries falls back to the raw table when the rollup table is absent", async () => {
  const capture: { query?: string; params?: Record<string, unknown> } = {};

  await countSeries(
    fakeClickhouseRollup(capture, false),
    "project-1",
    "traces",
    { range: HOUR_RANGE },
    undefined,
    { n: 15, unit: "MINUTE" },
  );

  assert.match(capture.query ?? "", /FROM otel_traces/);
});
