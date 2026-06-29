import { createRequire } from "node:module";
import { gunzipSync, inflateSync } from "node:zlib";

import protobuf from "protobufjs";

import type { SourceParseConfig } from "@superlog/db/log-severity";

import {
  otlpLogsToRows,
  otlpTracesToRows,
  type OtelLogRow,
  type OtelTraceRow,
} from "./otlp-clickhouse.js";

// Traces protobuf: reuse the descriptors that ship with the OTLP transformer (same
// module the fingerprint stamper uses).
const require = createRequire(import.meta.url);
const otlpRoot = require("@opentelemetry/otlp-transformer/build/esm/generated/root.js");
const ExportTraceServiceRequest =
  otlpRoot.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest;

// Logs protobuf: the transformer's bundled root only includes trace + metrics, so we
// decode logs with a minimal inline descriptor. Field numbers follow the OTLP logs.proto
// v1 spec; protobufjs lower-camel-cases field names on decode, matching the mappers
// (resource_logs -> resourceLogs, time_unix_nano -> timeUnixNano, etc.).
const LOGS_PROTO = `
syntax = "proto3";
package otlplogs;
message ExportLogsServiceRequest { repeated ResourceLogs resource_logs = 1; }
message ResourceLogs { Resource resource = 1; repeated ScopeLogs scope_logs = 2; string schema_url = 3; }
message Resource { repeated KeyValue attributes = 1; uint32 dropped_attributes_count = 2; }
message ScopeLogs { InstrumentationScope scope = 1; repeated LogRecord log_records = 2; string schema_url = 3; }
message InstrumentationScope { string name = 1; string version = 2; repeated KeyValue attributes = 3; uint32 dropped_attributes_count = 4; }
message LogRecord {
  fixed64 time_unix_nano = 1;
  uint32 severity_number = 2;
  string severity_text = 3;
  AnyValue body = 5;
  repeated KeyValue attributes = 6;
  uint32 dropped_attributes_count = 7;
  fixed32 flags = 8;
  bytes trace_id = 9;
  bytes span_id = 10;
  fixed64 observed_time_unix_nano = 11;
  string event_name = 12;
}
message KeyValue { string key = 1; AnyValue value = 2; }
message AnyValue {
  oneof value {
    string string_value = 1;
    bool bool_value = 2;
    int64 int_value = 3;
    double double_value = 4;
    ArrayValue array_value = 5;
    KeyValueList kvlist_value = 6;
    bytes bytes_value = 7;
  }
}
message ArrayValue { repeated AnyValue values = 1; }
message KeyValueList { repeated KeyValue values = 1; }
`;
const ExportLogsServiceRequest = protobuf
  .parse(LOGS_PROTO)
  .root.lookupType("otlplogs.ExportLogsServiceRequest");

// toObject normalizes the decoded message into the plain camelCase shape the mappers
// expect: 64-bit fields (intValue, *UnixNano) become decimal strings, enums become
// numbers, and bytes (traceId/spanId) stay as Buffers so the mappers hex-encode them.
const PROTO_TO_OBJECT_OPTS = { longs: String, enums: Number, defaults: false };

export type DecodedRows =
  | { table: "otel_logs"; rows: OtelLogRow[] }
  | { table: "otel_traces"; rows: OtelTraceRow[] };

export type DecodeInput = {
  path: string;
  projectId: string;
  contentType: string;
  contentEncoding?: string;
  body: Buffer;
  // OTLP-source severity-parsing config for this project. Only used for
  // /v1/logs: records arriving with SeverityNumber=0 get their level filled in
  // from the body. Absent = no backfill (severity passes through as-is).
  parseConfig?: SourceParseConfig;
};

// Decode an OTLP ingest payload into ClickHouse rows. Returns null for signals we
// don't yet write directly (metrics) or content types we can't decode — the caller
// forwards those to the collector instead, so nothing is ever dropped.
export function decodeOtlpToRows(input: DecodeInput): DecodedRows | null {
  if (input.path !== "/v1/logs" && input.path !== "/v1/traces") return null;

  const json = input.contentType.toLowerCase().includes("json");
  const protobufContent = input.contentType.toLowerCase().includes("protobuf");
  if (!json && !protobufContent) return null;

  const body = decompress(input.body, input.contentEncoding);

  if (input.path === "/v1/logs") {
    const payload = json
      ? JSON.parse(body.toString("utf8"))
      : decodeProto(ExportLogsServiceRequest, body);
    return { table: "otel_logs", rows: otlpLogsToRows(payload, input.projectId, input.parseConfig) };
  }

  const payload = json
    ? JSON.parse(body.toString("utf8"))
    : decodeProto(ExportTraceServiceRequest, body);
  return { table: "otel_traces", rows: otlpTracesToRows(payload, input.projectId) };
}

// The proto reflection types (protobufjs Type / the otlp-transformer root) are
// untyped JS, so this stays loosely typed.
// biome-ignore lint/suspicious/noExplicitAny: protobufjs reflection Type is untyped
function decodeProto(type: any, body: Buffer): unknown {
  return type.toObject(type.decode(body), PROTO_TO_OBJECT_OPTS);
}

function decompress(body: Buffer, encoding?: string): Buffer {
  if (!encoding) return body;
  const enc = encoding.toLowerCase();
  if (enc === "gzip") return gunzipSync(body);
  if (enc === "deflate") return inflateSync(body);
  return body;
}
