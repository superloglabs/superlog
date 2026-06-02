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
