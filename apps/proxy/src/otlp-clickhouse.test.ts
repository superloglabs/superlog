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

test("otlpLogsToRows strips superlog.* from resource attrs and stamps the real project id", () => {
  const rows = otlpLogsToRows(logsExport, "proj-123");
  assert.equal(rows[0]!.ResourceAttributes["superlog.project_id"], "proj-123");
  assert.equal(rows[0]!.ResourceAttributes["service.name"], "checkout");
  assert.equal(rows[0]!.ResourceAttributes["service.version"], "1.2.3");
  // no stray superlog.* keys other than the stamped project id
  const superlogKeys = Object.keys(rows[0]!.ResourceAttributes).filter((k) => k.startsWith("superlog."));
  assert.deepEqual(superlogKeys, ["superlog.project_id"]);
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

test("otlpTracesToRows strips superlog.* from resource and span attrs, stamps project id", () => {
  const r = otlpTracesToRows(tracesExport, "proj-xyz")[0]!;
  assert.equal(r.ResourceAttributes["superlog.project_id"], "proj-xyz");
  assert.equal(r.ResourceAttributes["service.name"], "api");
  assert.equal(r.SpanAttributes["http.method"], "GET");
  // span-level superlog.* stripped (matches collector transform/strip_superlog)
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
