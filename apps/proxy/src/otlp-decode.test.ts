import { strict as assert } from "node:assert";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import protobuf from "protobufjs";

import { type DecodedRows, decodeOtlpToRows } from "./otlp-decode.js";
import type { OtelLogRow } from "./otlp-clickhouse.js";

// Narrows the decode result to log rows (or fails the test), satisfying the
// discriminated-union + no-unchecked-index typings.
function logRows(out: DecodedRows | null): OtelLogRow[] {
  if (!out || out.table !== "otel_logs") return assert.fail("expected otel_logs rows");
  return out.rows;
}

// An independent OTLP-logs encoder (standard field numbers) used to produce binary
// payloads in tests — verifies the decoder's inline descriptor is wire-compatible
// with what a real OTLP/protobuf logs client emits.
const ExportLogsServiceRequest = protobuf
  .parse(`
    syntax = "proto3";
    package t;
    message ExportLogsServiceRequest { repeated ResourceLogs resource_logs = 1; }
    message ResourceLogs { Resource resource = 1; repeated ScopeLogs scope_logs = 2; }
    message Resource { repeated KeyValue attributes = 1; }
    message ScopeLogs { repeated LogRecord log_records = 2; }
    message LogRecord { fixed64 time_unix_nano = 1; AnyValue body = 5; bytes trace_id = 9; }
    message KeyValue { string key = 1; AnyValue value = 2; }
    message AnyValue { oneof value { string string_value = 1; } }
  `)
  .root.lookupType("t.ExportLogsServiceRequest");

const jsonLogs = JSON.stringify({
  resourceLogs: [
    {
      resource: { attributes: [{ key: "service.name", value: { stringValue: "svc" } }] },
      scopeLogs: [
        {
          scope: { name: "s" },
          logRecords: [{ timeUnixNano: "1718000000000000000", body: { stringValue: "hi" } }],
        },
      ],
    },
  ],
});

test("decodeOtlpToRows decodes JSON logs to otel_logs rows", () => {
  const out = decodeOtlpToRows({
    path: "/v1/logs",
    projectId: "p1",
    contentType: "application/json",
    body: Buffer.from(jsonLogs),
  });
  const rows = logRows(out);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.Body, "hi");
  assert.equal(rows[0]!.ResourceAttributes["superlog.project_id"], "p1");
});

test("decodeOtlpToRows gunzips a gzip-encoded body", () => {
  const out = decodeOtlpToRows({
    path: "/v1/logs",
    projectId: "p1",
    contentType: "application/json",
    contentEncoding: "gzip",
    body: gzipSync(Buffer.from(jsonLogs)),
  });
  assert.equal(logRows(out)[0]!.Body, "hi");
});

test("decodeOtlpToRows decodes protobuf logs, normalizing int64 time and byte ids", () => {
  const msg = ExportLogsServiceRequest.create({
    resourceLogs: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "svc" } }] },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: "1718000000000000000",
                traceId: Buffer.from("5b8efff798038103d269b633813fc60c", "hex"),
                body: { stringValue: "hi" },
              },
            ],
          },
        ],
      },
    ],
  });
  const body = Buffer.from(ExportLogsServiceRequest.encode(msg).finish());

  const out = decodeOtlpToRows({
    path: "/v1/logs",
    projectId: "p1",
    contentType: "application/x-protobuf",
    body,
  });
  const rows = logRows(out);
  assert.equal(rows[0]!.Body, "hi");
  // int64 nanos survived (longs:String) and byte trace id hex-encoded
  assert.equal(rows[0]!.Timestamp, "2024-06-10 06:13:20.000000000");
  assert.equal(rows[0]!.TraceId, "5b8efff798038103d269b633813fc60c");
});

test("decodeOtlpToRows returns null for metrics (falls through to collector)", () => {
  assert.equal(
    decodeOtlpToRows({ path: "/v1/metrics", projectId: "p", contentType: "application/json", body: Buffer.from("{}") }),
    null,
  );
});

test("decodeOtlpToRows returns null for an undecodable content type", () => {
  assert.equal(
    decodeOtlpToRows({ path: "/v1/logs", projectId: "p", contentType: "text/plain", body: Buffer.from("x") }),
    null,
  );
});

test("decodeOtlpToRows handles client-supplied superlog attributes based on stamped status", () => {
  const jsonLogsWithSpoofedFingerprint = JSON.stringify({
    resourceLogs: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "svc" } }] },
        scopeLogs: [
          {
            scope: { name: "s" },
            logRecords: [
              {
                timeUnixNano: "1718000000000000000",
                body: { stringValue: "hi" },
                attributes: [
                  { key: "superlog.issue_fingerprint", value: { stringValue: "fake" } },
                  { key: "superlog.other_key", value: { stringValue: "val" } },
                  { key: "normal_key", value: { stringValue: "ok" } }
                ]
              }
            ],
          },
        ],
      },
    ],
  });

  // Test Case 1: stamped = true -> preserves issue_fingerprint, strips other superlog keys
  const resStamped = decodeOtlpToRows({
    path: "/v1/logs",
    projectId: "p1",
    contentType: "application/json",
    body: Buffer.from(jsonLogsWithSpoofedFingerprint),
    stamped: true,
  });
  assert.ok(resStamped);
  assert.equal(resStamped.table, "otel_logs");
  assert.equal(resStamped.strippedCount, 0);
  assert.equal(resStamped.rows[0]!.LogAttributes["superlog.issue_fingerprint"], "fake");
  assert.equal(resStamped.rows[0]!.LogAttributes["superlog.other_key"], undefined);
  assert.equal(resStamped.rows[0]!.LogAttributes["normal_key"], "ok");

  // Test Case 2: stamped = false -> strips all superlog keys including issue_fingerprint
  const resUnstamped = decodeOtlpToRows({
    path: "/v1/logs",
    projectId: "p1",
    contentType: "application/json",
    body: Buffer.from(jsonLogsWithSpoofedFingerprint),
    stamped: false,
  });
  assert.ok(resUnstamped);
  assert.equal(resUnstamped.table, "otel_logs");
  assert.equal(resUnstamped.strippedCount, 1);
  assert.equal(resUnstamped.rows[0]!.LogAttributes["superlog.issue_fingerprint"], undefined);
  assert.equal(resUnstamped.rows[0]!.LogAttributes["superlog.other_key"], undefined);
  assert.equal(resUnstamped.rows[0]!.LogAttributes["normal_key"], "ok");
});
