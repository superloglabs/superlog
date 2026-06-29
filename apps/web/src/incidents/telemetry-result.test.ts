import assert from "node:assert/strict";
import test from "node:test";
import {
  formatRangeLabel,
  normalizeBucket,
  parseResultRows,
  telemetryToolKind,
  toMetricRows,
  toTraceRows,
} from "./telemetry-result.ts";

test("telemetryToolKind maps the three query tools and nothing else", () => {
  assert.equal(telemetryToolKind("query_metrics"), "metrics");
  assert.equal(telemetryToolKind("query_logs"), "logs");
  assert.equal(telemetryToolKind("query_traces"), "traces");
  assert.equal(telemetryToolKind("save_issue"), null);
  assert.equal(telemetryToolKind("list_services"), null);
  assert.equal(telemetryToolKind(undefined), null);
});

test("parseResultRows parses a JSON array of objects", () => {
  const rows = parseResultRows('[{"value":2},{"value":3}]');
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.value, 2);
});

test("parseResultRows is null-safe and rejects non-arrays / scalars / bad JSON", () => {
  assert.deepEqual(parseResultRows(null), []);
  assert.deepEqual(parseResultRows(undefined), []);
  assert.deepEqual(parseResultRows("[]"), []);
  assert.deepEqual(parseResultRows("not json"), []);
  assert.deepEqual(parseResultRows('{"a":1}'), []); // object, not array
  assert.deepEqual(parseResultRows("[1,2,3]"), []); // scalars filtered out
});

test("normalizeBucket trims ClickHouse nanos and T separator to second precision", () => {
  assert.equal(normalizeBucket("2026-06-26 02:51:34.850000000"), "2026-06-26 02:51:34");
  assert.equal(normalizeBucket("2026-06-26T02:51:34Z"), "2026-06-26 02:51:34");
});

test("toMetricRows pulls value/sum/count, drops bad rows, sorts ascending", () => {
  const rows = toMetricRows(
    [
      { timestamp: "2026-06-26 02:51:20.000", value: 2 },
      { timestamp: "2026-06-26 02:51:10.000", value: 1 },
      { timestamp: "bad" }, // no value
      { value: 5 }, // no timestamp
      { timestamp: "2026-06-26 02:51:30.000", sum: 7 }, // falls back to sum
    ],
    "auth.signin.failures",
  );
  assert.deepEqual(
    rows.map((r) => [r.bucket, r.value]),
    [
      ["2026-06-26 02:51:10", 1],
      ["2026-06-26 02:51:20", 2],
      ["2026-06-26 02:51:30", 7],
    ],
  );
  assert.equal(rows[0]!.group, "auth.signin.failures");
});

test("toTraceRows coerces the span fields the table needs, tolerating missing ones", () => {
  const rows = toTraceRows([
    {
      timestamp: "2026-06-26 02:51:34.850000000",
      service: "core-platform",
      span_name: "POST /api/auth/events",
      status_code: "STATUS_CODE_UNSET",
      duration_ms: 41,
      trace_id: "ffadbe50",
    },
    { service: "x" }, // sparse row still yields a shaped object
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.span_name, "POST /api/auth/events");
  assert.equal(rows[0]!.duration_ms, 41);
  assert.equal(rows[1]!.service, "x");
  assert.equal(rows[1]!.span_name, "");
  assert.equal(rows[1]!.duration_ms, 0);
});

test("formatRangeLabel renders ISO ranges as UTC HH:MM, passes ClickHouse exprs through", () => {
  assert.equal(
    formatRangeLabel({ since: "2026-06-26T02:40:00Z", until: "2026-06-26T03:10:00Z" }),
    "02:40 – 03:10 UTC",
  );
  assert.equal(
    formatRangeLabel({ since: "now() - INTERVAL 2 HOUR", until: "now()" }),
    "now() - INTERVAL 2 HOUR → now()",
  );
  assert.equal(formatRangeLabel(undefined), "");
});
