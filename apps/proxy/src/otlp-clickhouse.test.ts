import { strict as assert } from "node:assert";
import { test } from "node:test";

import { otlpLogsToRows, otlpTracesToRows } from "./otlp-clickhouse.js";

// A minimal OTLP/JSON logs export, shaped like what the OTLP receiver decodes.
// One resource (with a superlog.* routing key that must be stripped), one scope,
// two log records (one with trace context + rich attributes, one bare).
const logsExport = {
  resourceLogs: [
    {
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: "checkout" } },
          { key: "service.version", value: { stringValue: "1.2.3" } },
          // routing key the proxy stamped — collector strips all superlog.* then
          // re-adds superlog.project_id from the request metadata.
          { key: "superlog.project_id", value: { stringValue: "WRONG-should-be-overwritten" } },
        ],
      },
      schemaUrl: "https://schema/res",
      scopeLogs: [
        {
          scope: { name: "my.logger", version: "0.1.0", attributes: [] },
          schemaUrl: "https://schema/scope",
          logRecords: [
            {
              timeUnixNano: "1718000000123456789",
              severityText: "ERROR",
              severityNumber: 17,
              traceId: "5b8efff798038103d269b633813fc60c",
              spanId: "eee19b7ec3c1b174",
              flags: 1,
              body: { stringValue: "boom" },
              eventName: "exception",
              attributes: [
                { key: "http.status", value: { intValue: "500" } },
                { key: "retried", value: { boolValue: true } },
                { key: "ratio", value: { doubleValue: 0.5 } },
                { key: "tags", value: { arrayValue: { values: [{ stringValue: "a" }, { stringValue: "b" }] } } },
                { key: "codes", value: { arrayValue: { values: [{ intValue: "1" }, { intValue: "2" }] } } },
                { key: "bigids", value: { arrayValue: { values: [{ intValue: "9007199254740993" }] } } },
                // proxy-stamped routing key; collector strips superlog.* from log attrs too
                { key: "superlog.issue_fingerprint", value: { stringValue: "deadbeef" } },
              ],
            },
            {
              // no time set → falls back to observedTimeUnixNano
              observedTimeUnixNano: "1718000000000000000",
              body: { stringValue: "plain" },
            },
          ],
        },
      ],
    },
  ],
};

test("otlpLogsToRows maps one row per log record with collector-compatible columns", () => {
  const rows = otlpLogsToRows(logsExport, "proj-123");
  assert.equal(rows.length, 2);

  const r = rows[0]!;
  assert.equal(r.ServiceName, "checkout");
  assert.equal(r.Body, "boom");
  assert.equal(r.SeverityText, "ERROR");
  assert.equal(r.SeverityNumber, 17);
  assert.equal(r.TraceId, "5b8efff798038103d269b633813fc60c");
  assert.equal(r.SpanId, "eee19b7ec3c1b174");
  assert.equal(r.TraceFlags, 1);
  assert.equal(r.ScopeName, "my.logger");
  assert.equal(r.ScopeVersion, "0.1.0");
  assert.equal(r.ResourceSchemaUrl, "https://schema/res");
  assert.equal(r.ScopeSchemaUrl, "https://schema/scope");
  assert.equal(r.EventName, "exception");
  // nanosecond-precise timestamp, UTC, 9 fractional digits
  assert.equal(r.Timestamp, "2024-06-10 06:13:20.123456789");
});

test("otlpLogsToRows strips untrusted superlog.* but preserves proxy-stamped issue_fingerprint", () => {
  const rows = otlpLogsToRows(logsExport, "proj-123", true);
  assert.equal(rows[0]!.ResourceAttributes["superlog.project_id"], "proj-123");
  assert.equal(rows[0]!.ResourceAttributes["service.name"], "checkout");
  assert.equal(rows[0]!.ResourceAttributes["service.version"], "1.2.3");
  // no stray superlog.* keys other than the stamped project id
  const superlogKeys = Object.keys(rows[0]!.ResourceAttributes).filter((k) => k.startsWith("superlog."));
  assert.deepEqual(superlogKeys, ["superlog.project_id"]);
  // superlog.issue_fingerprint is proxy-authored and MUST survive so the
  // issue-activity materialized views can match it (regression for #285).
  assert.equal(rows[0]!.LogAttributes["superlog.issue_fingerprint"], "deadbeef");
  // other log attributes are unaffected
  assert.equal(rows[0]!.LogAttributes["http.status"], "500");
});

test("otlpLogsToRows stringifies log attribute values like the collector Map(String,String)", () => {
  const rows = otlpLogsToRows(logsExport, "proj-123");
  const a = rows[0]!.LogAttributes;
  assert.equal(a["http.status"], "500");
  assert.equal(a["retried"], "true");
  assert.equal(a["ratio"], "0.5");
  assert.equal(a["tags"], '["a","b"]');
  // nested ints serialize as numeric JSON tokens, matching the collector
  assert.equal(a["codes"], "[1,2]");
  // int64 beyond 2^53 keeps full precision (not rounded via JS Number)
  assert.equal(a["bigids"], "[9007199254740993]");
});

test("otlpLogsToRows falls back to observedTimeUnixNano and empty trace context", () => {
  const rows = otlpLogsToRows(logsExport, "proj-123");
  const r = rows[1]!;
  assert.equal(r.Body, "plain");
  assert.equal(r.TraceId, "");
  assert.equal(r.SpanId, "");
  assert.equal(r.SeverityText, "");
  assert.equal(r.SeverityNumber, 0);
  assert.equal(r.Timestamp, "2024-06-10 06:13:20.000000000");
});

test("otlpLogsToRows tolerates an empty export", () => {
  assert.deepEqual(otlpLogsToRows({}, "proj-123"), []);
  assert.deepEqual(otlpLogsToRows({ resourceLogs: [] }, "proj-123"), []);
});

const tracesExport = {
  resourceSpans: [
    {
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: "api" } },
          { key: "superlog.project_id", value: { stringValue: "WRONG" } },
        ],
      },
      scopeSpans: [
        {
          scope: { name: "instr.http", version: "2.0.0" },
          spans: [
            {
              traceId: "5b8efff798038103d269b633813fc60c",
              spanId: "eee19b7ec3c1b174",
              parentSpanId: "aaaa19b7ec3c1b17",
              traceState: "rojo=00f067aa",
              name: "GET /x",
              kind: 3, // Client
              startTimeUnixNano: "1718000000000000000",
              endTimeUnixNano: "1718000001849000000", // +1.849s
              status: { code: 2, message: "boom" },
              attributes: [
                { key: "http.method", value: { stringValue: "GET" } },
                { key: "superlog.issue_fingerprint", value: { stringValue: "deadbeef" } },
              ],
              events: [
                {
                  timeUnixNano: "1718000000500000000",
                  name: "exception",
                  attributes: [{ key: "exception.type", value: { stringValue: "Error" } }],
                },
              ],
              links: [
                {
                  traceId: "11111111111111111111111111111111",
                  spanId: "2222222222222222",
                  traceState: "",
                  attributes: [],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

test("otlpTracesToRows maps spans with collector-compatible columns", () => {
  const rows = otlpTracesToRows(tracesExport, "proj-xyz");
  assert.equal(rows.length, 1);
  const r = rows[0]!;
  assert.equal(r.ServiceName, "api");
  assert.equal(r.SpanName, "GET /x");
  assert.equal(r.SpanKind, "Client");
  assert.equal(r.StatusCode, "Error");
  assert.equal(r.StatusMessage, "boom");
  assert.equal(r.TraceId, "5b8efff798038103d269b633813fc60c");
  assert.equal(r.SpanId, "eee19b7ec3c1b174");
  assert.equal(r.ParentSpanId, "aaaa19b7ec3c1b17");
  assert.equal(r.TraceState, "rojo=00f067aa");
  assert.equal(r.ScopeName, "instr.http");
  assert.equal(r.ScopeVersion, "2.0.0");
  assert.equal(r.Duration, "1849000000"); // UInt64 nanoseconds as a string
  assert.equal(r.Timestamp, "2024-06-10 06:13:20.000000000");
});

test("otlpTracesToRows strips untrusted superlog.* from resource and span attrs, preserves issue_fingerprint", () => {
  const r = otlpTracesToRows(tracesExport, "proj-xyz", true)[0]!;
  assert.equal(r.ResourceAttributes["superlog.project_id"], "proj-xyz");
  assert.equal(r.ResourceAttributes["service.name"], "api");
  assert.equal(r.SpanAttributes["http.method"], "GET");
  // client-supplied issue_fingerprint on span attributes is stripped unconditionally
  assert.equal(r.SpanAttributes["superlog.issue_fingerprint"], undefined);
});

test("otlpTracesToRows flattens events and links into parallel arrays", () => {
  const r = otlpTracesToRows(tracesExport, "proj-xyz")[0]!;
  assert.deepEqual(r["Events.Name"], ["exception"]);
  assert.equal(r["Events.Timestamp"][0]!, "2024-06-10 06:13:20.500000000");
  assert.deepEqual(r["Events.Attributes"], [{ "exception.type": "Error" }]);
  assert.deepEqual(r["Links.TraceId"], ["11111111111111111111111111111111"]);
  assert.deepEqual(r["Links.SpanId"], ["2222222222222222"]);
});

test("otlpTracesToRows tolerates an empty export", () => {
  assert.deepEqual(otlpTracesToRows({}, "p"), []);
});

// ── Regression tests for #285 ────────────────────────────────────────────────
// The proxy stamps superlog.issue_fingerprint as authoritative data before
// selecting a delivery branch. Neither the direct-ClickHouse mapper nor the
// collector pipeline should strip it; the issue-activity materialized views
// require it to be present on both logs and trace events.

test("regression #285: issue_fingerprint survives direct-ClickHouse mapping for logs", () => {
  const fp = { key: "superlog.issue_fingerprint", value: { stringValue: "fp16" } };
  const control = { key: "exception.type", value: { stringValue: "Error" } };
  const rows = otlpLogsToRows(
    {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                { timeUnixNano: "1000000000", severityNumber: 17, attributes: [control, fp] },
              ],
            },
          ],
        },
      ],
    },
    "p",
    true,
  );
  // Fingerprint must reach ClickHouse so the log activity view admits the row.
  assert.equal(
    rows[0]!.LogAttributes["superlog.issue_fingerprint"],
    "fp16",
    "issue_fingerprint must be preserved in LogAttributes",
  );
  // Neighbouring control attribute must also survive (non-regression).
  assert.equal(rows[0]!.LogAttributes["exception.type"], "Error");
});

test("regression #285: issue_fingerprint survives direct-ClickHouse mapping for trace events", () => {
  const fp = { key: "superlog.issue_fingerprint", value: { stringValue: "fp16" } };
  const control = { key: "exception.type", value: { stringValue: "Error" } };
  const rows = otlpTracesToRows(
    {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  startTimeUnixNano: "1000000000",
                  endTimeUnixNano: "2000000000",
                  events: [{ name: "exception", timeUnixNano: "1000000000", attributes: [control, fp] }],
                },
              ],
            },
          ],
        },
      ],
    },
    "p",
    true,
  );
  // Fingerprint must reach ClickHouse so the trace activity view admits the row.
  assert.equal(
    rows[0]!["Events.Attributes"][0]!["superlog.issue_fingerprint"],
    "fp16",
    "issue_fingerprint must be preserved in Events.Attributes",
  );
  // Neighbouring control attribute must also survive (non-regression).
  assert.equal(rows[0]!["Events.Attributes"][0]!["exception.type"], "Error");
});

test("control #285: ordinary (non-superlog) attributes are unaffected", () => {
  const attrs = [
    { key: "exception.type", value: { stringValue: "Error" } },
    { key: "user.id", value: { stringValue: "u1" } },
  ];
  const logRows = otlpLogsToRows(
    {
      resourceLogs: [
        { scopeLogs: [{ logRecords: [{ timeUnixNano: "1000000000", severityNumber: 17, attributes: attrs }] }] },
      ],
    },
    "p",
  );
  const traceRows = otlpTracesToRows(
    {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  startTimeUnixNano: "1000000000",
                  endTimeUnixNano: "2000000000",
                  events: [{ name: "exception", timeUnixNano: "1000000000", attributes: attrs }],
                },
              ],
            },
          ],
        },
      ],
    },
    "p",
  );
  assert.equal(logRows[0]!.LogAttributes["exception.type"], "Error");
  assert.equal(logRows[0]!.LogAttributes["user.id"], "u1");
  assert.equal(traceRows[0]!["Events.Attributes"][0]!["exception.type"], "Error");
  assert.equal(traceRows[0]!["Events.Attributes"][0]!["user.id"], "u1");
});

test("otlpLogsToRows strips issue_fingerprint when stamped is false", () => {
  const fp = { key: "superlog.issue_fingerprint", value: { stringValue: "fp16" } };
  const control = { key: "exception.type", value: { stringValue: "Error" } };
  const tracker = { strippedCount: 0 };
  const rows = otlpLogsToRows(
    {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                { timeUnixNano: "1000000000", severityNumber: 17, attributes: [control, fp] },
              ],
            },
          ],
        },
      ],
    },
    "p",
    false,
    tracker,
  );
  assert.equal(rows[0]!.LogAttributes["superlog.issue_fingerprint"], undefined);
  assert.equal(rows[0]!.LogAttributes["exception.type"], "Error");
  assert.equal(tracker.strippedCount, 1);
});

test("otlpTracesToRows strips issue_fingerprint when stamped is false", () => {
  const fp = { key: "superlog.issue_fingerprint", value: { stringValue: "fp16" } };
  const control = { key: "exception.type", value: { stringValue: "Error" } };
  const tracker = { strippedCount: 0 };
  const rows = otlpTracesToRows(
    {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  startTimeUnixNano: "1000000000",
                  endTimeUnixNano: "2000000000",
                  events: [{ name: "exception", timeUnixNano: "1000000000", attributes: [control, fp] }],
                },
              ],
            },
          ],
        },
      ],
    },
    "p",
    false,
    tracker,
  );
  assert.equal(rows[0]!["Events.Attributes"][0]!["superlog.issue_fingerprint"], undefined);
  assert.equal(rows[0]!["Events.Attributes"][0]!["exception.type"], "Error");
  assert.equal(tracker.strippedCount, 1);
});
