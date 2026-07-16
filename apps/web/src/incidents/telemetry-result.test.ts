import assert from "node:assert/strict";
import test from "node:test";
import {
  exploreHref,
  formatRangeLabel,
  normalizeBucket,
  parseTelemetryResult,
  parseResultRows,
  telemetryToolKind,
  telemetryResultNotice,
  toMetricRows,
  toTraceRows,
} from "./telemetry-result.ts";

// react-router decodes `attr` values, so compare on the decoded query the
// Explore page actually receives rather than the percent-encoded raw string.
function decodedParams(href: string): {
  path: string;
  attrs: string[];
  rest: Record<string, string>;
} {
  const [path, qs = ""] = href.split("?");
  const p = new URLSearchParams(qs);
  const attrs = p.getAll("attr");
  const rest: Record<string, string> = {};
  for (const [k, v] of p) if (k !== "attr") rest[k] = v;
  return { path: path!, attrs, rest };
}

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

test("parseTelemetryResult distinguishes an empty query from a legacy truncated result", () => {
  assert.deepEqual(parseTelemetryResult("[]"), {
    rows: [],
    state: "complete",
    originalRowCount: 0,
  });
  assert.deepEqual(parseTelemetryResult('[{"trace_id":"abc","span_name":"fetch...'), {
    rows: [],
    state: "truncated",
    originalRowCount: null,
  });
});

test("parseTelemetryResult keeps an omitted truncated total unknown", () => {
  assert.deepEqual(parseTelemetryResult('[{"trace_id":"abc"}]', { truncated: true }), {
    rows: [{ trace_id: "abc" }],
    state: "truncated",
    originalRowCount: null,
  });
});

test("telemetryResultNotice describes partial and unavailable recorded results", () => {
  assert.equal(
    telemetryResultNotice("truncated", 3, 50),
    "Showing 3 of 50 recorded rows; the stored result was truncated.",
  );
  assert.equal(
    telemetryResultNotice("truncated", 0, null),
    "The recorded result was truncated before it could be displayed.",
  );
  assert.equal(
    telemetryResultNotice("invalid", 0, null),
    "The recorded result could not be displayed.",
  );
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

test("exploreHref points at the matching source with no filters when input is bare", () => {
  assert.equal(exploreHref("logs", {}), "/explore/logs");
  assert.equal(exploreHref("traces", {}), "/explore/traces");
  assert.equal(exploreHref("metrics", {}), "/explore/metrics");
});

test("exploreHref maps service to a service.name resource-attr filter", () => {
  const { path, attrs, rest } = decodedParams(exploreHref("logs", { service: "core-platform" }));
  assert.equal(path, "/explore/logs");
  assert.deepEqual(attrs, ["service.name=core-platform"]);
  assert.deepEqual(rest, {});
});

test("exploreHref carries resource_attrs through as attr filters, after service", () => {
  const { attrs } = decodedParams(
    exploreHref("traces", {
      service: "api",
      resource_attrs: [
        { key: "host.name", value: "prod-1" },
        { key: "deployment.environment", value: "prod" },
      ],
    }),
  );
  assert.deepEqual(attrs, ["service.name=api", "host.name=prod-1", "deployment.environment=prod"]);
});

test("exploreHref maps severity to sev only for logs", () => {
  assert.deepEqual(decodedParams(exploreHref("logs", { severity: "ERROR" })).rest, {
    sev: "ERROR",
  });
  // severity is meaningless on traces/metrics — dropped
  assert.deepEqual(decodedParams(exploreHref("traces", { severity: "ERROR" })).rest, {});
});

test("exploreHref maps status_code to status only for traces", () => {
  assert.deepEqual(
    decodedParams(exploreHref("traces", { status_code: "STATUS_CODE_ERROR" })).rest,
    {
      status: "STATUS_CODE_ERROR",
    },
  );
  assert.deepEqual(
    decodedParams(exploreHref("logs", { status_code: "STATUS_CODE_ERROR" })).rest,
    {},
  );
});

test("exploreHref maps metric_name to metric only for metrics", () => {
  assert.deepEqual(
    decodedParams(exploreHref("metrics", { metric_name: "auth.signin.failures" })).rest,
    { metric: "auth.signin.failures" },
  );
  assert.deepEqual(
    decodedParams(exploreHref("logs", { metric_name: "auth.signin.failures" })).rest,
    {},
  );
});

test("exploreHref drops filters Explore's URL can't express (span_name, search, span/log attrs)", () => {
  const { attrs, rest } = decodedParams(
    exploreHref("traces", {
      span_name: "POST /api/auth/events",
      search: "timeout",
      span_attrs: [{ key: "http.method", value: "POST" }],
      log_attrs: [{ key: "code", value: "500" }],
    }),
  );
  assert.deepEqual(attrs, []);
  assert.deepEqual(rest, {});
});

test("exploreHref ignores empty/blank filter values and malformed attrs", () => {
  const { attrs, rest } = decodedParams(
    exploreHref("logs", {
      service: "",
      severity: "",
      resource_attrs: [{ key: "", value: "x" }, { value: "novalue" }, { key: "ok" }],
    }),
  );
  assert.deepEqual(attrs, ["ok="]);
  assert.deepEqual(rest, {});
});

test("exploreHref carries an absolute ISO window through as since/until", () => {
  const { rest } = decodedParams(
    exploreHref("logs", {
      range: { since: "2026-06-26T02:40:00Z", until: "2026-06-26T03:10:00Z" },
    }),
  );
  assert.deepEqual(rest, {
    since: "2026-06-26T02:40:00Z",
    until: "2026-06-26T03:10:00Z",
  });
});

test("exploreHref drops a ClickHouse-expression range (not URL-addressable)", () => {
  const { rest } = decodedParams(
    exploreHref("metrics", {
      metric_name: "auth.signin.failures",
      range: { since: "now() - INTERVAL 2 HOUR", until: "now()" },
    }),
  );
  // only the metric survives; the relative expression can't be pinned in the URL
  assert.deepEqual(rest, { metric: "auth.signin.failures" });
});

test("exploreHref drops a half-specified or inverted range", () => {
  assert.deepEqual(
    decodedParams(exploreHref("traces", { range: { since: "2026-06-26T03:00:00Z" } })).rest,
    {},
  );
  assert.deepEqual(
    decodedParams(
      exploreHref("traces", {
        range: { since: "2026-06-26T03:10:00Z", until: "2026-06-26T02:40:00Z" },
      }),
    ).rest,
    {},
  );
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
