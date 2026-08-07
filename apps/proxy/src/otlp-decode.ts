import { createRequire } from "node:module";
import { gunzipSync, inflateSync } from "node:zlib";

import protobuf from "protobufjs";

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
const ExportMetricsServiceRequest =
  otlpRoot.opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest;

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

// Cap on the decompressed size of a compressed ingest body. Without it,
// gunzipSync/inflateSync expand a highly-compressible "zip bomb" (gzip reaches
// ~1000x) to tens of GB synchronously, blocking the event loop and OOM-killing
// the consumer — a single valid key could take down the fleet. 256 MiB is well
// above any legitimate OTLP batch (bodies are already capped at 64 MiB
// compressed) while refusing the pathological case. Overridable per-call.
export const DEFAULT_MAX_DECOMPRESSED_BYTES = 256 * 1024 * 1024;

export type DecodeInput = {
  path: string;
  projectId: string;
  contentType: string;
  contentEncoding?: string;
  body: Buffer;
  /** Cap on decompressed body size; defaults to DEFAULT_MAX_DECOMPRESSED_BYTES. */
  maxDecompressedBytes?: number;
};

// Decode an OTLP ingest payload into ClickHouse rows. Returns null for signals we
// don't yet write directly (metrics) or content types we can't decode — the caller
// forwards those to the collector instead, so nothing is ever dropped.
export function decodeOtlpToRows(input: DecodeInput): DecodedRows | null {
  if (input.path !== "/v1/logs" && input.path !== "/v1/traces") return null;

  const json = input.contentType.toLowerCase().includes("json");
  const protobufContent = input.contentType.toLowerCase().includes("protobuf");
  if (!json && !protobufContent) return null;

  const body = decompress(
    input.body,
    input.contentEncoding,
    input.maxDecompressedBytes ?? DEFAULT_MAX_DECOMPRESSED_BYTES,
  );

  if (input.path === "/v1/logs") {
    const payload = json
      ? JSON.parse(body.toString("utf8"))
      : decodeProto(ExportLogsServiceRequest, body);
    return { table: "otel_logs", rows: otlpLogsToRows(payload, input.projectId) };
  }

  const payload = json
    ? JSON.parse(body.toString("utf8"))
    : decodeProto(ExportTraceServiceRequest, body);
  return { table: "otel_traces", rows: otlpTracesToRows(payload, input.projectId) };
}

// Decode an OTLP metrics export request (JSON or protobuf, possibly
// compressed) into its OTLP-JSON object shape. Used by ingest routes that
// must rewrite a metrics payload before forwarding (e.g. the Render
// metrics-stream route stamps telemetry.source). Unknown content types are
// treated as protobuf — that's OTLP/HTTP's default encoding.
export function decodeOtlpMetricsPayload(input: {
  contentType: string;
  contentEncoding?: string;
  body: Buffer;
}): unknown {
  const body = decompress(input.body, input.contentEncoding);
  if (input.contentType.toLowerCase().includes("json")) {
    return JSON.parse(body.toString("utf8"));
  }
  return decodeProto(ExportMetricsServiceRequest, body);
}

// The proto reflection types (protobufjs Type / the otlp-transformer root) are
// untyped JS, so this stays loosely typed.
// biome-ignore lint/suspicious/noExplicitAny: protobufjs reflection Type is untyped
function decodeProto(type: any, body: Buffer): unknown {
  return type.toObject(type.decode(body), PROTO_TO_OBJECT_OPTS);
}

// Bounded decompression. maxOutputLength makes zlib throw
// RangeError[ERR_BUFFER_TOO_LARGE] instead of allocating past the cap, so a
// decompression bomb fails fast; decodeOtlpToRows callers already treat a decode
// throw as best-effort (log + forward to collector), so it degrades, not crashes.
function decompress(body: Buffer, encoding: string | undefined, maxOutputLength: number): Buffer {
  if (!encoding) return body;
  const enc = encoding.toLowerCase();
  if (enc === "gzip") return gunzipSync(body, { maxOutputLength });
  if (enc === "deflate") return inflateSync(body, { maxOutputLength });
  return body;
}
