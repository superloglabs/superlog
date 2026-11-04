import { fingerprint, fingerprintLog } from "@superlog/fingerprint";

// The one attribute the ClickHouse issue-activity materialized views read
// (infra/clickhouse/migrations/002_issue_activity_daily.sql). The proxy owns
// it: clients cannot set it, and it is recomputed rather than trusted on the
// direct-to-ClickHouse path.
export const ISSUE_FINGERPRINT_ATTRIBUTE = "superlog.issue_fingerprint";

// Structural subset of OTLP KeyValue. Narrow on purpose: both the ingest
// helpers and the row mapper can pass their own decoded types without casts.
export type FingerprintAttributeValue = {
  stringValue?: string;
  intValue?: number | string;
  doubleValue?: number;
  boolValue?: boolean;
};

export type FingerprintAttribute = { key?: string; value?: FingerprintAttributeValue };

export function attributeString(
  attrs: readonly FingerprintAttribute[],
  key: string,
): string | null {
  return valueString(attrs.find((attr) => attr.key === key)?.value);
}

// Same predicate the stamping path uses to decide a log is worth fingerprinting:
// OTel ERROR and above, or any severity that carries exception evidence.
export function isErrorLog(
  severityNumber: number | undefined,
  severityText: string | undefined,
  attrs: readonly FingerprintAttribute[],
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
    attributeString(attrs, "exception.type") || attributeString(attrs, "exception.stacktrace"),
  );
}

export function traceExceptionFingerprint(attrs: readonly FingerprintAttribute[]): string {
  return fingerprint({
    type: attributeString(attrs, "exception.type") || "Error",
    message: attributeString(attrs, "exception.message"),
    stacktrace: attributeString(attrs, "exception.stacktrace"),
  }).hash;
}

export function errorLogFingerprint(input: {
  service: string;
  severityText?: string;
  severityNumber?: number;
  body: string;
  attrs: readonly FingerprintAttribute[];
}): string | null {
  if (!isErrorLog(input.severityNumber, input.severityText, input.attrs)) return null;
  return fingerprintLog({
    service: input.service,
    severity: input.severityText || String(input.severityNumber ?? ""),
    body: input.body,
    exceptionType: attributeString(input.attrs, "exception.type"),
    stacktrace: attributeString(input.attrs, "exception.stacktrace"),
  }).hash;
}

function valueString(value: FingerprintAttributeValue | undefined): string | null {
  if (!value) return null;
  if (typeof value.stringValue === "string") return value.stringValue;
  if (typeof value.intValue === "number" || typeof value.intValue === "string")
    return String(value.intValue);
  if (typeof value.doubleValue === "number") return String(value.doubleValue);
  if (typeof value.boolValue === "boolean") return String(value.boolValue);
  return null;
}
