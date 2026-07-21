import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { type ClickHouseClient, createClient } from "@clickhouse/client";
import { metricAggregate, metricSeries, queryMetrics } from "./index.js";

const clickhouseUrl = process.env.CLICKHOUSE_URL;
const database = `metric_temporality_${randomUUID().replaceAll("-", "")}`;
let admin: ClickHouseClient;
let ch: ClickHouseClient;

before(async () => {
  if (!clickhouseUrl) return;
  admin = createClient({ url: clickhouseUrl });
  await admin.command({ query: `CREATE DATABASE ${database}` });
  ch = createClient({ url: clickhouseUrl, database });
  await ch.command({
    query: `
      CREATE TABLE otel_metrics_sum
      (
        ResourceAttributes Map(String, String),
        ResourceSchemaUrl String,
        ScopeName String,
        ScopeVersion String,
        ScopeAttributes Map(String, String),
        ScopeSchemaUrl String,
        ServiceName String,
        MetricName String,
        MetricUnit String,
        Attributes Map(String, String),
        StartTimeUnix DateTime64(9),
        TimeUnix DateTime64(9),
        Value Float64,
        AggregationTemporality Int32,
        IsMonotonic Bool
      )
      ENGINE = MergeTree
      ORDER BY (MetricName, TimeUnix)
    `,
  });
  await ch.command({
    query:
      "CREATE TABLE otel_metrics_gauge AS otel_metrics_sum ENGINE = MergeTree ORDER BY (MetricName, TimeUnix)",
  });
  for (const table of ["otel_metrics_histogram", "otel_metrics_summary"]) {
    await ch.command({
      query: `
        CREATE TABLE ${table}
        (
          ResourceAttributes Map(String, String),
          ResourceSchemaUrl String,
          ScopeName String,
          ScopeVersion String,
          ScopeAttributes Map(String, String),
          ScopeSchemaUrl String,
          ServiceName String,
          MetricName String,
          MetricUnit String,
          Attributes Map(String, String),
          StartTimeUnix DateTime64(9),
          TimeUnix DateTime64(9),
          Count UInt64,
          Sum Float64,
          Min Float64,
          Max Float64,
          BucketCounts Array(UInt64),
          ExplicitBounds Array(Float64),
          AggregationTemporality Int32
        )
        ENGINE = MergeTree
        ORDER BY (MetricName, TimeUnix)
      `,
    });
  }
  await ch.command({
    query: `
      CREATE TABLE otel_metrics_exp_histogram
      (
        ResourceAttributes Map(String, String),
        ResourceSchemaUrl String,
        ScopeName String,
        ScopeVersion String,
        ScopeAttributes Map(String, String),
        ScopeSchemaUrl String,
        ServiceName String,
        MetricName String,
        MetricUnit String,
        Attributes Map(String, String),
        StartTimeUnix DateTime64(9),
        TimeUnix DateTime64(9),
        Count UInt64,
        Sum Float64,
        Scale Int32,
        ZeroCount UInt64,
        PositiveOffset Int32,
        PositiveBucketCounts Array(UInt64),
        NegativeOffset Int32,
        NegativeBucketCounts Array(UInt64),
        Min Float64,
        Max Float64,
        AggregationTemporality Int32
      )
      ENGINE = MergeTree
      ORDER BY (MetricName, TimeUnix)
    `,
  });
});

after(async () => {
  if (!clickhouseUrl) return;
  await ch.close();
  await admin.command({ query: `DROP DATABASE ${database}` });
  await admin.close();
});

test(
  "cumulative counters include the portion of the boundary interval inside the requested window",
  { skip: !clickhouseUrl },
  async () => {
    await ch.insert({
      table: "otel_metrics_sum",
      format: "JSONEachRow",
      values: [
        cumulativeSumPoint("2026-01-01 00:00:30", 10),
        cumulativeSumPoint("2026-01-01 00:01:30", 30),
        cumulativeSumPoint("2026-01-01 00:02:30", 50),
      ],
    });

    const rows = await metricSeries(
      ch,
      "project-1",
      "requests.total",
      {
        range: {
          since: "2026-01-01T00:01:00Z",
          until: "2026-01-01T00:03:00Z",
        },
      },
      undefined,
      { n: 1, unit: "MINUTE" },
      "sum",
    );

    assert.deepEqual(rows, [
      { bucket: "2026-01-01 00:01:00", group: "", value: 20 },
      { bucket: "2026-01-01 00:02:00", group: "", value: 10 },
    ]);
  },
);

test("temporality queries accept relative DateTime bounds", { skip: !clickhouseUrl }, async () => {
  const rows = await metricSeries(
    ch,
    "project-1",
    "missing.relative.metric",
    { range: { since: "now() - INTERVAL 1 HOUR", until: "now()" } },
    undefined,
    { n: 1, unit: "MINUTE" },
    "sum",
  );

  assert.deepEqual(rows, []);
});

test(
  "cumulative counters do not count an unknown-start reset as a new increase",
  { skip: !clickhouseUrl },
  async () => {
    await ch.insert({
      table: "otel_metrics_sum",
      format: "JSONEachRow",
      values: [
        {
          ...cumulativeSumPoint("2026-01-01 00:01:30", 100),
          MetricName: "unknown_start.total",
          StartTimeUnix: "2026-01-01 00:01:30",
        },
      ],
    });

    const rows = await metricSeries(
      ch,
      "project-1",
      "unknown_start.total",
      {
        range: {
          since: "2026-01-01T00:01:00Z",
          until: "2026-01-01T00:02:00Z",
        },
      },
      undefined,
      { n: 1, unit: "MINUTE" },
      "sum",
    );

    assert.deepEqual(rows, []);
  },
);

test(
  "cumulative streams from distinct instrumentation scopes are differenced independently",
  { skip: !clickhouseUrl },
  async () => {
    await ch.insert({
      table: "otel_metrics_sum",
      format: "JSONEachRow",
      values: [
        { ...cumulativeSumPoint("2026-01-01 00:00:30", 10), MetricName: "scoped.total" },
        { ...cumulativeSumPoint("2026-01-01 00:01:30", 30), MetricName: "scoped.total" },
        {
          ...cumulativeSumPoint("2026-01-01 00:00:30", 100),
          MetricName: "scoped.total",
          ScopeName: "other.metrics",
        },
        {
          ...cumulativeSumPoint("2026-01-01 00:01:30", 150),
          MetricName: "scoped.total",
          ScopeName: "other.metrics",
        },
      ],
    });

    const rows = await metricSeries(
      ch,
      "project-1",
      "scoped.total",
      {
        range: {
          since: "2026-01-01T00:01:00Z",
          until: "2026-01-01T00:02:00Z",
        },
      },
      undefined,
      { n: 1, unit: "MINUTE" },
      "sum",
    );

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.bucket, "2026-01-01 00:01:00");
    assert.ok(Math.abs((rows[0]?.value ?? 0) - 35) < 1e-12);
  },
);

test(
  "a known cumulative reset is distributed over its declared start-to-end interval",
  { skip: !clickhouseUrl },
  async () => {
    await ch.insert({
      table: "otel_metrics_sum",
      format: "JSONEachRow",
      values: [
        {
          ...cumulativeSumPoint("2026-01-01 00:02:10", 60),
          MetricName: "known_reset.total",
          StartTimeUnix: "2026-01-01 00:01:10",
        },
      ],
    });

    const rows = await metricSeries(
      ch,
      "project-1",
      "known_reset.total",
      {
        range: {
          since: "2026-01-01T00:01:00Z",
          until: "2026-01-01T00:03:00Z",
        },
      },
      undefined,
      { n: 1, unit: "MINUTE" },
      "sum",
    );

    assert.deepEqual(rows, [
      { bucket: "2026-01-01 00:01:00", group: "", value: 50 },
      { bucket: "2026-01-01 00:02:00", group: "", value: 10 },
    ]);
  },
);

test(
  "cumulative non-monotonic sums preserve negative and positive changes",
  { skip: !clickhouseUrl },
  async () => {
    await ch.insert({
      table: "otel_metrics_sum",
      format: "JSONEachRow",
      values: [
        nonMonotonicCumulativePoint("2026-01-01 00:00:30", 10),
        nonMonotonicCumulativePoint("2026-01-01 00:01:30", 5),
        nonMonotonicCumulativePoint("2026-01-01 00:02:30", 8),
      ],
    });

    const rows = await metricSeries(
      ch,
      "project-1",
      "queue.depth.change",
      {
        range: {
          since: "2026-01-01T00:01:00Z",
          until: "2026-01-01T00:03:00Z",
        },
      },
      undefined,
      { n: 1, unit: "MINUTE" },
      "sum",
    );

    assert.deepEqual(rows, [
      { bucket: "2026-01-01 00:01:00", group: "", value: -1 },
      { bucket: "2026-01-01 00:02:00", group: "", value: 1.5 },
    ]);
  },
);

test(
  "delta sums are distributed over their declared start-to-end interval",
  { skip: !clickhouseUrl },
  async () => {
    await ch.insert({
      table: "otel_metrics_sum",
      format: "JSONEachRow",
      values: [
        {
          ...cumulativeSumPoint("2026-01-01 00:02:10", 60),
          MetricName: "delta.requests",
          StartTimeUnix: "2026-01-01 00:01:10",
          AggregationTemporality: 1,
        },
      ],
    });

    const rows = await metricSeries(
      ch,
      "project-1",
      "delta.requests",
      {
        range: {
          since: "2026-01-01T00:01:00Z",
          until: "2026-01-01T00:03:00Z",
        },
      },
      undefined,
      { n: 1, unit: "MINUTE" },
      "sum",
    );

    assert.deepEqual(rows, [
      { bucket: "2026-01-01 00:01:00", group: "", value: 50 },
      { bucket: "2026-01-01 00:02:00", group: "", value: 10 },
    ]);
  },
);

test(
  "non-sum counter aggregations operate on normalized interval contributions",
  { skip: !clickhouseUrl },
  async () => {
    const rows = await metricSeries(
      ch,
      "project-1",
      "requests.total",
      {
        range: {
          since: "2026-01-01T00:01:00Z",
          until: "2026-01-01T00:03:00Z",
        },
      },
      undefined,
      { n: 1, unit: "MINUTE" },
      "avg",
    );

    assert.deepEqual(rows, [
      { bucket: "2026-01-01 00:01:00", group: "", value: 10 },
      { bucket: "2026-01-01 00:02:00", group: "", value: 10 },
    ]);
  },
);

test(
  "cumulative histogram counts are differenced before temporal reaggregation",
  { skip: !clickhouseUrl },
  async () => {
    await ch.insert({
      table: "otel_metrics_histogram",
      format: "JSONEachRow",
      values: [
        cumulativeHistogramPoint("2026-01-01 00:00:30", 10, 100, [5, 5]),
        cumulativeHistogramPoint("2026-01-01 00:01:30", 30, 300, [15, 15]),
        cumulativeHistogramPoint("2026-01-01 00:02:30", 50, 500, [25, 25]),
      ],
    });

    const rows = await metricSeries(
      ch,
      "project-1",
      "request.duration",
      {
        range: {
          since: "2026-01-01T00:01:00Z",
          until: "2026-01-01T00:03:00Z",
        },
      },
      undefined,
      { n: 1, unit: "MINUTE" },
    );

    assert.deepEqual(rows, [
      { bucket: "2026-01-01 00:01:00", group: "", value: 20 },
      { bucket: "2026-01-01 00:02:00", group: "", value: 10 },
    ]);
  },
);

test(
  "cumulative histogram sums are differenced before temporal reaggregation",
  { skip: !clickhouseUrl },
  async () => {
    const rows = await metricSeries(
      ch,
      "project-1",
      "request.duration",
      {
        range: {
          since: "2026-01-01T00:01:00Z",
          until: "2026-01-01T00:03:00Z",
        },
      },
      undefined,
      { n: 1, unit: "MINUTE" },
      "sum",
    );

    assert.deepEqual(rows, [
      { bucket: "2026-01-01 00:01:00", group: "", value: 200 },
      { bucket: "2026-01-01 00:02:00", group: "", value: 100 },
    ]);
  },
);

test(
  "cumulative histogram averages use interval sums and counts",
  { skip: !clickhouseUrl },
  async () => {
    await ch.insert({
      table: "otel_metrics_histogram",
      format: "JSONEachRow",
      values: [
        {
          ...cumulativeHistogramPoint("2026-01-01 00:00:30", 10, 100, [5, 5]),
          MetricName: "request.variable_duration",
        },
        {
          ...cumulativeHistogramPoint("2026-01-01 00:01:30", 30, 500, [15, 15]),
          MetricName: "request.variable_duration",
        },
        {
          ...cumulativeHistogramPoint("2026-01-01 00:02:30", 50, 700, [25, 25]),
          MetricName: "request.variable_duration",
        },
      ],
    });

    const rows = await metricSeries(
      ch,
      "project-1",
      "request.variable_duration",
      {
        range: {
          since: "2026-01-01T00:01:00Z",
          until: "2026-01-01T00:03:00Z",
        },
      },
      undefined,
      { n: 1, unit: "MINUTE" },
      "avg",
    );

    assert.deepEqual(rows, [
      { bucket: "2026-01-01 00:01:00", group: "", value: 15 },
      { bucket: "2026-01-01 00:02:00", group: "", value: 10 },
    ]);
  },
);

test(
  "cumulative histogram percentiles use only newly observed bucket counts",
  { skip: !clickhouseUrl },
  async () => {
    await ch.insert({
      table: "otel_metrics_histogram",
      format: "JSONEachRow",
      values: [
        {
          ...cumulativeHistogramPoint("2026-01-01 00:00:30", 100, 500, [100, 0]),
          MetricName: "request.percentile_duration",
        },
        {
          ...cumulativeHistogramPoint("2026-01-01 00:01:30", 101, 520, [100, 1]),
          MetricName: "request.percentile_duration",
        },
        {
          ...cumulativeHistogramPoint("2026-01-01 00:02:30", 102, 540, [100, 2]),
          MetricName: "request.percentile_duration",
        },
      ],
    });

    const rows = await metricSeries(
      ch,
      "project-1",
      "request.percentile_duration",
      {
        range: {
          since: "2026-01-01T00:01:00Z",
          until: "2026-01-01T00:03:00Z",
        },
      },
      undefined,
      { n: 1, unit: "MINUTE" },
      "p95",
    );

    assert.deepEqual(rows, [
      { bucket: "2026-01-01 00:01:00", group: "", value: 20 },
      { bucket: "2026-01-01 00:02:00", group: "", value: 20 },
    ]);
  },
);

test(
  "delta histogram percentiles use the buckets from their declared interval",
  { skip: !clickhouseUrl },
  async () => {
    await ch.insert({
      table: "otel_metrics_histogram",
      format: "JSONEachRow",
      values: [
        {
          ...cumulativeHistogramPoint("2026-01-01 00:01:30", 20, 400, [0, 20]),
          MetricName: "delta.duration",
          StartTimeUnix: "2026-01-01 00:00:30",
          AggregationTemporality: 1,
        },
      ],
    });

    const rows = await metricSeries(
      ch,
      "project-1",
      "delta.duration",
      {
        range: {
          since: "2026-01-01T00:01:00Z",
          until: "2026-01-01T00:02:00Z",
        },
      },
      undefined,
      { n: 1, unit: "MINUTE" },
      "p95",
    );

    assert.deepEqual(rows, [{ bucket: "2026-01-01 00:01:00", group: "", value: 20 }]);
  },
);

test(
  "window-level histogram averages are weighted by observation count",
  { skip: !clickhouseUrl },
  async () => {
    await ch.insert({
      table: "otel_metrics_histogram",
      format: "JSONEachRow",
      values: [
        {
          ...cumulativeHistogramPoint("2026-01-01 00:01:00", 100, 100, [100, 0]),
          MetricName: "weighted.duration",
          StartTimeUnix: "2026-01-01 00:00:00",
          AggregationTemporality: 1,
        },
        {
          ...cumulativeHistogramPoint("2026-01-01 00:02:00", 1, 100, [0, 1]),
          MetricName: "weighted.duration",
          StartTimeUnix: "2026-01-01 00:01:00",
          AggregationTemporality: 1,
        },
      ],
    });

    const rows = await metricAggregate(
      ch,
      "project-1",
      "weighted.duration",
      {
        range: {
          since: "2026-01-01T00:00:00Z",
          until: "2026-01-01T00:02:00Z",
        },
      },
      undefined,
      "avg",
    );

    assert.equal(rows.length, 1);
    assert.ok(Math.abs((rows[0]?.value ?? 0) - 200 / 101) < 1e-12);
  },
);

test(
  "cumulative histogram min and max are not reported as interval extrema",
  { skip: !clickhouseUrl },
  async () => {
    const minRows = await metricSeries(
      ch,
      "project-1",
      "request.duration",
      {
        range: {
          since: "2026-01-01T00:01:00Z",
          until: "2026-01-01T00:03:00Z",
        },
      },
      undefined,
      { n: 1, unit: "MINUTE" },
      "min",
    );
    const maxRows = await metricSeries(
      ch,
      "project-1",
      "request.duration",
      {
        range: {
          since: "2026-01-01T00:01:00Z",
          until: "2026-01-01T00:03:00Z",
        },
      },
      undefined,
      { n: 1, unit: "MINUTE" },
      "max",
    );

    assert.deepEqual(minRows, []);
    assert.deepEqual(maxRows, []);
  },
);

test(
  "cumulative exponential histogram counts are available and temporality-aware",
  { skip: !clickhouseUrl },
  async () => {
    await ch.insert({
      table: "otel_metrics_exp_histogram",
      format: "JSONEachRow",
      values: [
        cumulativeExponentialHistogramPoint("2026-01-01 00:00:30", 10, 100),
        cumulativeExponentialHistogramPoint("2026-01-01 00:01:30", 30, 300),
        cumulativeExponentialHistogramPoint("2026-01-01 00:02:30", 50, 500),
      ],
    });

    const rows = await metricSeries(
      ch,
      "project-1",
      "request.exp_duration",
      {
        range: {
          since: "2026-01-01T00:01:00Z",
          until: "2026-01-01T00:03:00Z",
        },
      },
      undefined,
      { n: 1, unit: "MINUTE" },
    );

    assert.deepEqual(rows, [
      { bucket: "2026-01-01 00:01:00", group: "", value: 20 },
      { bucket: "2026-01-01 00:02:00", group: "", value: 10 },
    ]);
  },
);

test(
  "cumulative exponential histogram percentiles use differenced bucket counts",
  { skip: !clickhouseUrl },
  async () => {
    const rows = await metricSeries(
      ch,
      "project-1",
      "request.exp_duration",
      {
        range: {
          since: "2026-01-01T00:01:00Z",
          until: "2026-01-01T00:03:00Z",
        },
      },
      undefined,
      { n: 1, unit: "MINUTE" },
      "p95",
    );

    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.ok(Math.abs(row.value - Math.SQRT2) < 1e-12);
    }
  },
);

test(
  "raw exponential histogram points expose their temporality and start time",
  { skip: !clickhouseUrl },
  async () => {
    const rows = await queryMetrics(ch, "project-1", {
      metricName: "request.exp_duration",
      range: {
        since: "2026-01-01T00:00:00Z",
        until: "2026-01-01T00:03:00Z",
      },
      limit: 10,
    });

    assert.equal(rows.length, 3);
    assert.equal(rows[0]?.kind, "exponential_histogram");
    assert.equal(rows[0]?.aggregation_temporality, 2);
    assert.equal(rows[0]?.start_time, "2026-01-01 00:00:00.000000000");
  },
);

function cumulativeSumPoint(time: string, value: number) {
  return {
    ResourceAttributes: { "superlog.project_id": "project-1" },
    ResourceSchemaUrl: "",
    ScopeName: "test.metrics",
    ScopeVersion: "1.0.0",
    ScopeAttributes: {},
    ScopeSchemaUrl: "",
    ServiceName: "checkout",
    MetricName: "requests.total",
    MetricUnit: "{request}",
    Attributes: {},
    StartTimeUnix: "2026-01-01 00:00:00",
    TimeUnix: time,
    Value: value,
    AggregationTemporality: 2,
    IsMonotonic: true,
  };
}

function nonMonotonicCumulativePoint(time: string, value: number) {
  return {
    ...cumulativeSumPoint(time, value),
    MetricName: "queue.depth.change",
    IsMonotonic: false,
  };
}

function cumulativeHistogramPoint(
  time: string,
  count: number,
  sum: number,
  bucketCounts: number[],
) {
  return {
    ResourceAttributes: { "superlog.project_id": "project-1" },
    ResourceSchemaUrl: "",
    ScopeName: "test.metrics",
    ScopeVersion: "1.0.0",
    ScopeAttributes: {},
    ScopeSchemaUrl: "",
    ServiceName: "checkout",
    MetricName: "request.duration",
    MetricUnit: "ms",
    Attributes: {},
    StartTimeUnix: "2026-01-01 00:00:00",
    TimeUnix: time,
    Count: count,
    Sum: sum,
    Min: 1,
    Max: 20,
    BucketCounts: bucketCounts,
    ExplicitBounds: [10],
    AggregationTemporality: 2,
  };
}

function cumulativeExponentialHistogramPoint(time: string, count: number, sum: number) {
  return {
    ResourceAttributes: { "superlog.project_id": "project-1" },
    ResourceSchemaUrl: "",
    ScopeName: "test.metrics",
    ScopeVersion: "1.0.0",
    ScopeAttributes: {},
    ScopeSchemaUrl: "",
    ServiceName: "checkout",
    MetricName: "request.exp_duration",
    MetricUnit: "ms",
    Attributes: {},
    StartTimeUnix: "2026-01-01 00:00:00",
    TimeUnix: time,
    Count: count,
    Sum: sum,
    Scale: 1,
    ZeroCount: 0,
    PositiveOffset: 0,
    PositiveBucketCounts: [count],
    NegativeOffset: 0,
    NegativeBucketCounts: [],
    Min: 1,
    Max: 20,
    AggregationTemporality: 2,
  };
}
