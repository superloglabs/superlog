import { createRequire } from "node:module";
import { fingerprint, fingerprintLog } from "@superlog/fingerprint";
import { type Counter, metrics } from "@opentelemetry/api";
import protobuf from "protobufjs";

const ISSUE_FINGERPRINT_ATTRIBUTE = "superlog.issue_fingerprint";

let fingerprintStrippedCounter: Counter | null = null;
export function getFingerprintStrippedCounter(): Counter {
  if (!fingerprintStrippedCounter) {
    const meter = metrics.getMeter("@superlog/proxy/operational");
    fingerprintStrippedCounter = meter.createCounter("superlog.proxy.fingerprint_stripped_total", {
      description: "Total number of client-supplied superlog.issue_fingerprint attributes stripped.",
    });
  }
  return fingerprintStrippedCounter;
}
const require = createRequire(import.meta.url);
const otlpRoot = require("@opentelemetry/otlp-transformer/build/esm/generated/root.js");
const ExportTraceServiceRequest =
  otlpRoot.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest;

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

const PROTO_TO_OBJECT_OPTS = { longs: String, enums: Number, defaults: false };

type OtlpAnyValue = {
  stringValue?: string;
  intValue?: number | string;
  doubleValue?: number;
  boolValue?: boolean;
};

type OtlpKeyValue = {
  key?: string;
  value?: OtlpAnyValue;
};

type StampInput = {
  path: string;
  contentType: string;
  contentEncoding?: string;
  body: Buffer;
};

export type StampedIngestPayload = {
  body: Buffer;
  stampedCount: number;
  strippedCount: number;
  stamped: boolean;
};

// Fingerprint stamping deserializes the whole body (JSON.parse / protobuf decode) and
// re-serializes it. For a multi-MB OTLP batch that is a 100s-of-MB synchronous spike that
// blocks the event loop and can OOM-kill the process. Anything large enough to be offloaded
// to S3 (>240 KB inline budget) is far past the size of a normal error batch, so we skip
// enrichment for those rather than parse them. Inline queue bodies are always under this cap.
export const MAX_FINGERPRINT_BODY_BYTES = 256_000;

export function stampIssueFingerprintsWithinLimit(
  input: StampInput,
  maxBytes: number = MAX_FINGERPRINT_BODY_BYTES,
): StampedIngestPayload {
  if (input.body.byteLength > maxBytes)
    return { body: input.body, stampedCount: 0, strippedCount: 0, stamped: false };
  return stampIssueFingerprints(input);
}

export interface FingerprintLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

// Enrichment must never break ingest: a malformed payload that throws during stamping is
// still forwarded verbatim (fail-open). Returns the body to send downstream.
export function stampIssueFingerprintsFailOpen(
  input: StampInput & { projectId: string },
  logger: FingerprintLogger,
): { body: Buffer; stamped: boolean } {
  try {
    const stamped = stampIssueFingerprintsWithinLimit(input);
    if (stamped.stampedCount > 0) {
      logger.info(
        {
          path: input.path,
          projectId: input.projectId ?? "unknown",
          stampedCount: stamped.stampedCount,
        },
        "stamped issue fingerprints on ingest payload",
      );
    }
    if (stamped.strippedCount > 0) {
      getFingerprintStrippedCounter().add(stamped.strippedCount, {
        path: input.path,
        projectId: input.projectId ?? "unknown",
      });
      logger.warn(
        {
          path: input.path,
          projectId: input.projectId ?? "unknown",
          strippedCount: stamped.strippedCount,
        },
        "stripped client-supplied superlog.issue_fingerprint attributes on ingest payload",
      );
    }
    return { body: stamped.body, stamped: stamped.stamped };
  } catch (err) {
    logger.warn(
      {
        err,
        path: input.path,
        projectId: input.projectId ?? "unknown",
        contentType: input.contentType,
      },
      "failed to stamp issue fingerprints on ingest payload",
    );
    return { body: input.body, stamped: false };
  }
}

export function stampIssueFingerprints(input: StampInput): StampedIngestPayload {
  if (input.contentEncoding) return { body: input.body, stampedCount: 0, strippedCount: 0, stamped: false };

  if (input.path === "/v1/traces" && isJsonContentType(input.contentType)) {
    const res = stampJsonTraceFingerprints(input.body);
    return { ...res, stamped: true };
  }
  if (input.path === "/v1/traces" && isProtobufContentType(input.contentType)) {
    const res = stampProtobufTraceFingerprints(input.body);
    return { ...res, stamped: true };
  }
  if (input.path === "/v1/logs" && isJsonContentType(input.contentType)) {
    const res = stampJsonLogFingerprints(input.body);
    return { ...res, stamped: true };
  }
  if (input.path === "/v1/logs" && isProtobufContentType(input.contentType)) {
    const res = stampProtobufLogFingerprints(input.body);
    return { ...res, stamped: true };
  }
  return { body: input.body, stampedCount: 0, strippedCount: 0, stamped: false };
}

function stampJsonTraceFingerprints(body: Buffer): StampedIngestPayload {
  const payload = JSON.parse(body.toString("utf8")) as {
    resourceSpans?: Array<{
      scopeSpans?: Array<{
        spans?: Array<{
          events?: Array<{
            name?: string;
            attributes?: OtlpKeyValue[];
          }>;
        }>;
      }>;
    }>;
  };

  let stampedCount = 0;
  let strippedCount = 0;
  for (const resourceSpan of payload.resourceSpans ?? []) {
    for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
      for (const span of scopeSpan.spans ?? []) {
        for (const event of span.events ?? []) {
          // Strip any client-supplied fingerprint unconditionally so a client
          // cannot inject a fake value on non-exception events that the
          // stamper skips. For exception events, setStringAttribute overwrites
          // it with the proxy-computed hash immediately after.
          const before = event.attributes ?? [];
          const after = before.filter((a) => a.key !== ISSUE_FINGERPRINT_ATTRIBUTE);
          if (after.length !== before.length) strippedCount += 1;
          event.attributes = after;
          if (event.name !== "exception") continue;
          const attrs = event.attributes;
          const fp = fingerprint({
            type: stringAttribute(attrs, "exception.type") || "Error",
            message: stringAttribute(attrs, "exception.message"),
            stacktrace: stringAttribute(attrs, "exception.stacktrace"),
          });
          event.attributes = setStringAttribute(attrs, ISSUE_FINGERPRINT_ATTRIBUTE, fp.hash);
          stampedCount += 1;
        }
      }
    }
  }

  // Re-serialize if anything changed — stripping alone mutates the parsed
  // object in memory but the caller receives the original Buffer unless we
  // re-encode here.
  if (stampedCount === 0 && strippedCount === 0)
    return { body, stampedCount: 0, strippedCount: 0 };
  return { body: Buffer.from(JSON.stringify(payload)), stampedCount, strippedCount };
}

function stampProtobufTraceFingerprints(body: Buffer): StampedIngestPayload {
  const payload = ExportTraceServiceRequest.decode(body) as {
    resourceSpans?: Array<{
      scopeSpans?: Array<{
        spans?: Array<{
          events?: Array<{
            name?: string;
            attributes?: OtlpKeyValue[];
          }>;
        }>;
      }>;
    }>;
  };

  let stampedCount = 0;
  let strippedCount = 0;
  for (const resourceSpan of payload.resourceSpans ?? []) {
    for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
      for (const span of scopeSpan.spans ?? []) {
        for (const event of span.events ?? []) {
          // Strip any client-supplied fingerprint unconditionally — same
          // rationale as stampJsonTraceFingerprints.
          const before = event.attributes ?? [];
          const after = before.filter((a) => a.key !== ISSUE_FINGERPRINT_ATTRIBUTE);
          if (after.length !== before.length) strippedCount += 1;
          event.attributes = after;
          if (event.name !== "exception") continue;
          const attrs = event.attributes;
          const fp = fingerprint({
            type: stringAttribute(attrs, "exception.type") || "Error",
            message: stringAttribute(attrs, "exception.message"),
            stacktrace: stringAttribute(attrs, "exception.stacktrace"),
          });
          event.attributes = setStringAttribute(attrs, ISSUE_FINGERPRINT_ATTRIBUTE, fp.hash);
          stampedCount += 1;
        }
      }
    }
  }

  // Re-serialize if anything changed — stripping alone mutates the parsed
  // object in memory but the caller receives the original Buffer unless we
  // re-encode here.
  if (stampedCount === 0 && strippedCount === 0)
    return { body, stampedCount: 0, strippedCount: 0 };
  return {
    body: Buffer.from(ExportTraceServiceRequest.encode(payload).finish()),
    stampedCount,
    strippedCount,
  };
}

function stampJsonLogFingerprints(body: Buffer): StampedIngestPayload {
  const payload = JSON.parse(body.toString("utf8")) as {
    resourceLogs?: Array<{
      resource?: { attributes?: OtlpKeyValue[] };
      scopeLogs?: Array<{
        logRecords?: Array<{
          severityText?: string;
          severityNumber?: number;
          body?: OtlpAnyValue;
          attributes?: OtlpKeyValue[];
        }>;
      }>;
    }>;
  };

  let stampedCount = 0;
  let strippedCount = 0;
  for (const resourceLog of payload.resourceLogs ?? []) {
    const service =
      stringAttribute(resourceLog.resource?.attributes ?? [], "service.name") || "unknown";
    for (const scopeLog of resourceLog.scopeLogs ?? []) {
      for (const logRecord of scopeLog.logRecords ?? []) {
        // Strip any client-supplied fingerprint unconditionally so a client
        // cannot inject a fake value for non-error logs the stamper skips.
        const before = logRecord.attributes ?? [];
        const after = before.filter((a) => a.key !== ISSUE_FINGERPRINT_ATTRIBUTE);
        if (after.length !== before.length) strippedCount += 1;
        logRecord.attributes = after;
        const attrs = logRecord.attributes;
        if (!isErrorLog(logRecord.severityNumber, logRecord.severityText, attrs)) continue;
        const fp = fingerprintLog({
          service,
          severity: logRecord.severityText || String(logRecord.severityNumber ?? ""),
          body: stringValue(logRecord.body) ?? "",
          exceptionType: stringAttribute(attrs, "exception.type"),
          stacktrace: stringAttribute(attrs, "exception.stacktrace"),
        });
        logRecord.attributes = setStringAttribute(attrs, ISSUE_FINGERPRINT_ATTRIBUTE, fp.hash);
        stampedCount += 1;
      }
    }
  }

  // Re-serialize if anything changed — stripping alone mutates the parsed
  // object in memory but the caller receives the original Buffer unless we
  // re-encode here.
  if (stampedCount === 0 && strippedCount === 0)
    return { body, stampedCount: 0, strippedCount: 0 };
  return { body: Buffer.from(JSON.stringify(payload)), stampedCount, strippedCount };
}

function stampProtobufLogFingerprints(body: Buffer): { body: Buffer; stampedCount: number; strippedCount: number } {
  const decoded = ExportLogsServiceRequest.decode(body);
  const payload = ExportLogsServiceRequest.toObject(decoded, PROTO_TO_OBJECT_OPTS) as {
    resourceLogs?: Array<{
      resource?: { attributes?: OtlpKeyValue[] };
      scopeLogs?: Array<{
        logRecords?: Array<{
          severityText?: string;
          severityNumber?: number;
          body?: OtlpAnyValue;
          attributes?: OtlpKeyValue[];
        }>;
      }>;
    }>;
  };

  let stampedCount = 0;
  let strippedCount = 0;
  for (const resourceLog of payload.resourceLogs ?? []) {
    const service =
      stringAttribute(resourceLog.resource?.attributes ?? [], "service.name") || "unknown";
    for (const scopeLog of resourceLog.scopeLogs ?? []) {
      for (const logRecord of scopeLog.logRecords ?? []) {
        const before = logRecord.attributes ?? [];
        const after = before.filter((a) => a.key !== ISSUE_FINGERPRINT_ATTRIBUTE);
        if (after.length !== before.length) strippedCount += 1;
        logRecord.attributes = after;
        const attrs = logRecord.attributes;
        if (!isErrorLog(logRecord.severityNumber, logRecord.severityText, attrs)) continue;
        const fp = fingerprintLog({
          service,
          severity: logRecord.severityText || String(logRecord.severityNumber ?? ""),
          body: stringValue(logRecord.body) ?? "",
          exceptionType: stringAttribute(attrs, "exception.type"),
          stacktrace: stringAttribute(attrs, "exception.stacktrace"),
        });
        logRecord.attributes = setStringAttribute(attrs, ISSUE_FINGERPRINT_ATTRIBUTE, fp.hash);
        stampedCount += 1;
      }
    }
  }

  if (stampedCount === 0 && strippedCount === 0)
    return { body, stampedCount: 0, strippedCount: 0 };
  return {
    body: Buffer.from(ExportLogsServiceRequest.encode(payload).finish()),
    stampedCount,
    strippedCount,
  };
}

function isJsonContentType(contentType: string): boolean {
  return contentType.toLowerCase().includes("json");
}

function isProtobufContentType(contentType: string): boolean {
  return contentType.toLowerCase().includes("protobuf");
}

function isErrorLog(
  severityNumber: number | undefined,
  severityText: string | undefined,
  attrs: OtlpKeyValue[],
): boolean {
  if (typeof severityNumber === "number" && severityNumber >= 17) return true;
  const normalizedSeverity = severityText?.toUpperCase();
  if (
    normalizedSeverity === "ERROR" ||
    normalizedSeverity === "FATAL" ||
    normalizedSeverity === "CRITICAL"
  ) {
    return true;
  }
  return Boolean(
    stringAttribute(attrs, "exception.type") || stringAttribute(attrs, "exception.stacktrace"),
  );
}

function setStringAttribute(attrs: OtlpKeyValue[], key: string, value: string): OtlpKeyValue[] {
  const next = attrs.filter((attr) => attr.key !== key);
  next.push({ key, value: { stringValue: value } });
  return next;
}

function stringAttribute(attrs: OtlpKeyValue[], key: string): string | null {
  return stringValue(attrs.find((attr) => attr.key === key)?.value);
}

function stringValue(value: OtlpAnyValue | undefined): string | null {
  if (!value) return null;
  if (typeof value.stringValue === "string") return value.stringValue;
  if (typeof value.intValue === "number" || typeof value.intValue === "string")
    return String(value.intValue);
  if (typeof value.doubleValue === "number") return String(value.doubleValue);
  if (typeof value.boolValue === "boolean") return String(value.boolValue);
  return null;
}
