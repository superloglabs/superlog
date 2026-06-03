import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ClickHouseClient } from "@clickhouse/client";
import {
  countSeries,
  fieldColumnExpr,
  listAttributeKeys,
  listAttributeValues,
  metricSeries,
  queryLogs,
  queryMetrics,
  queryTraces,
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

// queryMetrics fans out across four metric tables, so a single-slot capture
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
  // Per-sample increase (delta) from the cumulative value.
  assert.match(sumQuery, /lagInFrame\(toNullable\(Value\), 1, NULL\)/);
  assert.match(sumQuery, /Value - previous_value/);
  // First sample of a series has no predecessor: only count it if the series
  // actually started inside the window.
  assert.match(sumQuery, /StartTimeUnix >= now\(\) - INTERVAL 1 HOUR/);
  // The increase is spread over the wall-clock interval (prev sample -> this
  // sample) by weighting each render bucket's overlap with that interval —
  // this is what removes the "comb" when the step is finer than the export
  // interval. Needs the previous sample's timestamp and an overlap weight.
  assert.match(sumQuery, /lagInFrame\(TimeUnix, 1, TimeUnix\)/);
  assert.match(sumQuery, /ARRAY JOIN spread/);
  assert.match(sumQuery, /least\(b, g \+ 60\) - greatest\(a, g\)/);
  assert.match(sumQuery, /\/ dt/);
  // Non-cumulative / non-monotonic points are still summed as-is.
  assert.match(sumQuery, /NOT \(AggregationTemporality = 2 AND IsMonotonic\)/);
  assert.match(sumQuery, /Attributes\[\{groupKey:String\}\] AS group_key/);
  assert.equal(queries.length, 4);
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

test("queryMetrics returns data-point attributes for every metric kind", async () => {
  const queries: string[] = [];

  await queryMetrics(fakeClickhouseMulti(queries), "project-1", {
    range: { since: "now() - INTERVAL 1 HOUR", until: "now()" },
    limit: 100,
  });

  assert.equal(queries.length, 4);
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
