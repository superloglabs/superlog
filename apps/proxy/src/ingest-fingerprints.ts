import { createRequire } from "node:module";
import { fingerprint, fingerprintLog } from "@superlog/fingerprint";

const ISSUE_FINGERPRINT_ATTRIBUTE = "superlog.issue_fingerprint";
const require = createRequire(import.meta.url);
const otlpRoot = require("@opentelemetry/otlp-transformer/build/esm/generated/root.js");
const ExportTraceServiceRequest =
  otlpRoot.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest;

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
  if (input.body.byteLength > maxBytes) return { body: input.body, stampedCount: 0 };
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
): Buffer {
  try {
    const stamped = stampIssueFingerprintsWithinLimit(input);
    if (stamped.stampedCount > 0) {
      logger.info(
        { path: input.path, projectId: input.projectId, stampedCount: stamped.stampedCount },
        "stamped issue fingerprints on ingest payload",
      );
    }
    return stamped.body;
  } catch (err) {
    logger.warn(
      { err, path: input.path, projectId: input.projectId, contentType: input.contentType },
      "failed to stamp issue fingerprints on ingest payload",
    );
    return input.body;
  }
}

export function stampIssueFingerprints(input: StampInput): StampedIngestPayload {
  if (input.contentEncoding) return { body: input.body, stampedCount: 0 };

  if (input.path === "/v1/traces" && isJsonContentType(input.contentType)) {
    return stampJsonTraceFingerprints(input.body);
  }
  if (input.path === "/v1/traces" && isProtobufContentType(input.contentType)) {
    return stampProtobufTraceFingerprints(input.body);
  }
  if (input.path === "/v1/logs" && isJsonContentType(input.contentType)) {
    return stampJsonLogFingerprints(input.body);
  }
  return { body: input.body, stampedCount: 0 };
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
  for (const resourceSpan of payload.resourceSpans ?? []) {
    for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
      for (const span of scopeSpan.spans ?? []) {
        for (const event of span.events ?? []) {
          if (event.name !== "exception") continue;
          const attrs = event.attributes ?? [];
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

  if (stampedCount === 0) return { body, stampedCount };
  return { body: Buffer.from(JSON.stringify(payload)), stampedCount };
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
  for (const resourceSpan of payload.resourceSpans ?? []) {
    for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
      for (const span of scopeSpan.spans ?? []) {
        for (const event of span.events ?? []) {
          if (event.name !== "exception") continue;
          const attrs = event.attributes ?? [];
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

  if (stampedCount === 0) return { body, stampedCount };
  return { body: Buffer.from(ExportTraceServiceRequest.encode(payload).finish()), stampedCount };
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
  for (const resourceLog of payload.resourceLogs ?? []) {
    const service =
      stringAttribute(resourceLog.resource?.attributes ?? [], "service.name") || "unknown";
    for (const scopeLog of resourceLog.scopeLogs ?? []) {
      for (const logRecord of scopeLog.logRecords ?? []) {
        const attrs = logRecord.attributes ?? [];
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

  if (stampedCount === 0) return { body, stampedCount };
  return { body: Buffer.from(JSON.stringify(payload)), stampedCount };
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
