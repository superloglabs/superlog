// Pure mapping from decoded OTLP payloads to ClickHouse row objects, matching
// the column layout the otelcol clickhouse exporter writes today (table DDL in
// infra/clickhouse/schema/ha-replicated-otel.sql). This lets the ingest-consumer
// write directly to ClickHouse — a parallel synchronous quorum insert per worker,
// acked back to SQS only on success — instead of funnelling every message through
// the collector, whose synchronous exporter serializes to ~one insert per task.
//
// FIDELITY GOAL: rows produced here must be byte-for-byte what the collector
// produces, because the read path (apps/api) queries specific columns and the
// attribute Maps. The collector pipeline we mirror is:
//   transform/strip_superlog  -> delete keys matching ^superlog\..* from
//                                 resource attrs AND log/span attrs
//   attributes/from_metadata  -> insert superlog.project_id (from the request's
//                                 x-superlog-project-id) into RESOURCE attrs
// so: strip every superlog.* key, then stamp superlog.project_id onto resource attrs.
//
// Logs and traces are implemented here. The five metrics tables follow the same
// shape and are a planned follow-up.

type OtlpAnyValue = {
  stringValue?: string;
  intValue?: number | string;
  doubleValue?: number;
  boolValue?: boolean;
  bytesValue?: string | Uint8Array;
  arrayValue?: { values?: OtlpAnyValue[] };
  kvlistValue?: { values?: OtlpKeyValue[] };
};

type OtlpKeyValue = { key?: string; value?: OtlpAnyValue };

type OtlpLogRecord = {
  timeUnixNano?: string | number;
  observedTimeUnixNano?: string | number;
  severityText?: string;
  severityNumber?: number;
  traceId?: string | Uint8Array;
  spanId?: string | Uint8Array;
  flags?: number;
  body?: OtlpAnyValue;
  eventName?: string;
  attributes?: OtlpKeyValue[];
};

type OtlpScopeLogs = {
  scope?: { name?: string; version?: string; attributes?: OtlpKeyValue[] };
  schemaUrl?: string;
  logRecords?: OtlpLogRecord[];
};

type OtlpResourceLogs = {
  resource?: { attributes?: OtlpKeyValue[] };
  schemaUrl?: string;
  scopeLogs?: OtlpScopeLogs[];
};

export type OtlpLogsExport = { resourceLogs?: OtlpResourceLogs[] };

// Columns of superlog.otel_logs, minus TimestampTime which is a DEFAULT column
// (toDateTime(Timestamp)) and must not be inserted.
export type OtelLogRow = {
  Timestamp: string;
  TraceId: string;
  SpanId: string;
  TraceFlags: number;
  SeverityText: string;
  SeverityNumber: number;
  ServiceName: string;
  Body: string;
  ResourceSchemaUrl: string;
  ResourceAttributes: Record<string, string>;
  ScopeSchemaUrl: string;
  ScopeName: string;
  ScopeVersion: string;
  ScopeAttributes: Record<string, string>;
  LogAttributes: Record<string, string>;
  EventName: string;
};

const SUPERLOG_PROJECT_ID_KEY = "superlog.project_id";
const ISSUE_FINGERPRINT_KEY = "superlog.issue_fingerprint";
const NANOS_PER_SECOND = 1_000_000_000n;

// Keys in the superlog.* namespace that are proxy-authored and must be
// preserved through the ClickHouse mapper. All other superlog.* keys are
// client-supplied and must be stripped to prevent tenant spoofing.
const PRESERVED_SUPERLOG_KEYS = new Set([ISSUE_FINGERPRINT_KEY]);

export function otlpLogsToRows(
  payload: OtlpLogsExport,
  projectId: string,
  stamped = false,
  tracker?: { strippedCount: number },
): OtelLogRow[] {
  const rows: OtelLogRow[] = [];
  for (const rl of payload.resourceLogs ?? []) {
    const resourceMap = kvListToMap(rl.resource?.attributes);
    const serviceName = resourceMap["service.name"] ?? "";
    const resourceAttributes = stripAllSuperlog(resourceMap, tracker);
    resourceAttributes[SUPERLOG_PROJECT_ID_KEY] = projectId;
    const resourceSchemaUrl = rl.schemaUrl ?? "";

    for (const sl of rl.scopeLogs ?? []) {
      const scopeName = sl.scope?.name ?? "";
      const scopeVersion = sl.scope?.version ?? "";
      const scopeAttributes = kvListToMap(sl.scope?.attributes);
      const scopeSchemaUrl = sl.schemaUrl ?? "";

      for (const lr of sl.logRecords ?? []) {
        rows.push({
          Timestamp: nanosToClickHouseDateTime64(pickTime(lr.timeUnixNano, lr.observedTimeUnixNano)),
          TraceId: toHex(lr.traceId),
          SpanId: toHex(lr.spanId),
          TraceFlags: lr.flags ?? 0,
          SeverityText: lr.severityText ?? "",
          SeverityNumber: lr.severityNumber ?? 0,
          ServiceName: serviceName,
          Body: anyValueToString(lr.body),
          ResourceSchemaUrl: resourceSchemaUrl,
          ResourceAttributes: resourceAttributes,
          ScopeSchemaUrl: scopeSchemaUrl,
          ScopeName: scopeName,
          ScopeVersion: scopeVersion,
          ScopeAttributes: scopeAttributes,
          LogAttributes: stripUntrustedSuperlog(kvListToMap(lr.attributes), stamped, tracker),
          EventName: lr.eventName ?? "",
        });
      }
    }
  }
  return rows;
}

type OtlpEvent = { timeUnixNano?: string | number; name?: string; attributes?: OtlpKeyValue[] };
type OtlpLink = {
  traceId?: string | Uint8Array;
  spanId?: string | Uint8Array;
  traceState?: string;
  attributes?: OtlpKeyValue[];
};
type OtlpSpan = {
  traceId?: string | Uint8Array;
  spanId?: string | Uint8Array;
  parentSpanId?: string | Uint8Array;
  traceState?: string;
  name?: string;
  kind?: number;
  startTimeUnixNano?: string | number;
  endTimeUnixNano?: string | number;
  attributes?: OtlpKeyValue[];
  status?: { code?: number; message?: string };
  events?: OtlpEvent[];
  links?: OtlpLink[];
};
type OtlpScopeSpans = {
  scope?: { name?: string; version?: string };
  spans?: OtlpSpan[];
};
type OtlpResourceSpans = {
  resource?: { attributes?: OtlpKeyValue[] };
  scopeSpans?: OtlpScopeSpans[];
};
export type OtlpTracesExport = { resourceSpans?: OtlpResourceSpans[] };

// Columns of superlog.otel_traces. The Events.* / Links.* nested columns are
// parallel arrays, one entry per event/link on the span.
export type OtelTraceRow = {
  Timestamp: string;
  TraceId: string;
  SpanId: string;
  ParentSpanId: string;
  TraceState: string;
  SpanName: string;
  SpanKind: string;
  ServiceName: string;
  ResourceAttributes: Record<string, string>;
  ScopeName: string;
  ScopeVersion: string;
  SpanAttributes: Record<string, string>;
  // UInt64 nanoseconds. Kept as a string so durations beyond 2^53 ns aren't
  // rounded by JS number coercion before they reach ClickHouse.
  Duration: string;
  StatusCode: string;
  StatusMessage: string;
  "Events.Timestamp": string[];
  "Events.Name": string[];
  "Events.Attributes": Record<string, string>[];
  "Links.TraceId": string[];
  "Links.SpanId": string[];
  "Links.TraceState": string[];
  "Links.Attributes": Record<string, string>[];
};

// pdata SpanKind.String() / StatusCode.String() — verified against real otel_traces rows.
const SPAN_KINDS = ["Unspecified", "Internal", "Server", "Client", "Producer", "Consumer"];
const STATUS_CODES = ["Unset", "Ok", "Error"];

export function otlpTracesToRows(
  payload: OtlpTracesExport,
  projectId: string,
  stamped = false,
  tracker?: { strippedCount: number },
): OtelTraceRow[] {
  const rows: OtelTraceRow[] = [];
  for (const rs of payload.resourceSpans ?? []) {
    const resourceMap = kvListToMap(rs.resource?.attributes);
    const serviceName = resourceMap["service.name"] ?? "";
    const resourceAttributes = stripAllSuperlog(resourceMap, tracker);
    resourceAttributes[SUPERLOG_PROJECT_ID_KEY] = projectId;

    for (const ss of rs.scopeSpans ?? []) {
      const scopeName = ss.scope?.name ?? "";
      const scopeVersion = ss.scope?.version ?? "";

      for (const span of ss.spans ?? []) {
        const start = toBigIntNanos(span.startTimeUnixNano);
        const end = toBigIntNanos(span.endTimeUnixNano);
        const events = span.events ?? [];
        const links = span.links ?? [];
        rows.push({
          Timestamp: nanosToClickHouseDateTime64(span.startTimeUnixNano ?? 0),
          TraceId: toHex(span.traceId),
          SpanId: toHex(span.spanId),
          ParentSpanId: toHex(span.parentSpanId),
          TraceState: span.traceState ?? "",
          SpanName: span.name ?? "",
          SpanKind: SPAN_KINDS[span.kind ?? 0] ?? "Unspecified",
          ServiceName: serviceName,
          ResourceAttributes: resourceAttributes,
          ScopeName: scopeName,
          ScopeVersion: scopeVersion,
          SpanAttributes: stripAllSuperlog(kvListToMap(span.attributes), tracker),
          Duration: (end > start ? end - start : 0n).toString(),
          StatusCode: STATUS_CODES[span.status?.code ?? 0] ?? "Unset",
          StatusMessage: span.status?.message ?? "",
          "Events.Timestamp": events.map((e) => nanosToClickHouseDateTime64(e.timeUnixNano ?? 0)),
          "Events.Name": events.map((e) => e.name ?? ""),
          "Events.Attributes": events.map((e) =>
            stripUntrustedSuperlog(kvListToMap(e.attributes), stamped, tracker),
          ),
          "Links.TraceId": links.map((l) => toHex(l.traceId)),
          "Links.SpanId": links.map((l) => toHex(l.spanId)),
          "Links.TraceState": links.map((l) => l.traceState ?? ""),
          "Links.Attributes": links.map((l) => stripAllSuperlog(kvListToMap(l.attributes), tracker)),
        });
      }
    }
  }
  return rows;
}

function toBigIntNanos(n: string | number | undefined): bigint {
  try {
    return BigInt(n ?? 0);
  } catch {
    return 0n;
  }
}

function kvListToMap(attrs: OtlpKeyValue[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of attrs ?? []) {
    if (kv.key === undefined || kv.key === null) continue;
    out[kv.key] = anyValueToString(kv.value);
  }
  return out;
}

// Strips ALL superlog.* attributes unconditionally. Used only for resource
// attributes, where the proxy never stamps issue_fingerprint — only
// superlog.project_id is re-added afterwards from the request context.
function stripAllSuperlog(
  map: Record<string, string>,
  tracker?: { strippedCount: number },
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    if (k.startsWith("superlog.")) {
      if (k === ISSUE_FINGERPRINT_KEY && tracker) {
        tracker.strippedCount += 1;
      }
      continue;
    }
    out[k] = v;
  }
  return out;
}

// Strips client-supplied superlog.* attributes while preserving proxy-authored
// keys (currently superlog.issue_fingerprint). Clients must not be able to
// spoof reserved namespace attributes; the proxy is the sole authoritative
// source and stamps its own keys after sanitisation.
function stripUntrustedSuperlog(
  map: Record<string, string>,
  stamped: boolean,
  tracker?: { strippedCount: number },
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    if (k.startsWith("superlog.")) {
      if (stamped && PRESERVED_SUPERLOG_KEYS.has(k)) {
        out[k] = v;
      } else {
        if (k === ISSUE_FINGERPRINT_KEY && tracker) {
          tracker.strippedCount += 1;
        }
      }
      continue;
    }
    out[k] = v;
  }
  return out;
}

// Mirrors pdata Value.AsString: scalars render as their plain string form, bytes
// as base64, and arrays/maps as JSON. Keep this in sync with the collector or the
// attribute Maps in ClickHouse will diverge.
export function anyValueToString(v: OtlpAnyValue | undefined): string {
  if (!v) return "";
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.boolValue !== undefined) return String(v.boolValue);
  if (v.intValue !== undefined) return String(v.intValue);
  if (v.doubleValue !== undefined) return String(v.doubleValue);
  if (v.bytesValue !== undefined) return bytesToBase64(v.bytesValue);
  if (v.arrayValue || v.kvlistValue) return jsonEncodeValue(v);
  return "";
}

// Serialize a complex OTLP value (array / kvlist) to JSON for the Map(String,String)
// column, matching the collector (pdata Value.AsString). Strings reuse JSON.stringify
// (identical JS-style escaping to the previous implementation); the one thing JSON
// can't express through JS is an int64 beyond 2^53, so ints are emitted as raw numeric
// tokens straight from their digit strings rather than coerced through Number — keeping
// full precision (e.g. [1,9007199254740993], not a rounded value).
function jsonEncodeValue(v: OtlpAnyValue | undefined): string {
  if (!v) return "null";
  if (v.stringValue !== undefined) return JSON.stringify(v.stringValue);
  if (v.boolValue !== undefined) return v.boolValue ? "true" : "false";
  if (v.intValue !== undefined) return integerToken(v.intValue);
  if (v.doubleValue !== undefined) return JSON.stringify(v.doubleValue);
  if (v.bytesValue !== undefined) return JSON.stringify(bytesToBase64(v.bytesValue));
  if (v.arrayValue) return `[${(v.arrayValue.values ?? []).map(jsonEncodeValue).join(",")}]`;
  if (v.kvlistValue) {
    const entries = (v.kvlistValue.values ?? [])
      .filter((kv) => kv.key !== undefined && kv.key !== null)
      .map((kv) => `${JSON.stringify(kv.key)}:${jsonEncodeValue(kv.value)}`);
    return `{${entries.join(",")}}`;
  }
  return "null";
}

// An OTLP int64 as a raw JSON numeric token. OTLP/JSON and the protobuf decoder
// (longs:String) deliver it as a digit string; emit verbatim so values past 2^53 keep
// full precision. Falls back to a quoted string for anything not a plain integer
// literal so we never emit invalid JSON.
function integerToken(intValue: number | string): string {
  if (typeof intValue === "number") return String(intValue);
  return /^-?\d+$/.test(intValue) ? intValue : JSON.stringify(intValue);
}

function bytesToBase64(b: string | Uint8Array): string {
  // JSON OTLP already encodes bytesValue as base64; protobuf decode yields raw bytes.
  return typeof b === "string" ? b : Buffer.from(b).toString("base64");
}

// OTLP ids are hex strings in JSON, raw bytes in protobuf; ClickHouse stores hex.
function toHex(id: string | Uint8Array | undefined): string {
  if (!id) return "";
  return typeof id === "string" ? id : Buffer.from(id).toString("hex");
}

function pickTime(
  timeUnixNano: string | number | undefined,
  observedTimeUnixNano: string | number | undefined,
): string | number {
  if (timeUnixNano !== undefined && timeUnixNano !== null && timeUnixNano !== 0 && timeUnixNano !== "0") {
    return timeUnixNano;
  }
  return observedTimeUnixNano ?? 0;
}

function nanosToClickHouseDateTime64(nanos: string | number): string {
  let n: bigint;
  try {
    n = BigInt(nanos);
  } catch {
    n = 0n;
  }
  if (n < 0n) n = 0n;
  const seconds = n / NANOS_PER_SECOND;
  const frac = n % NANOS_PER_SECOND;
  const d = new Date(Number(seconds) * 1000);
  const pad = (x: number, width = 2) => String(x).padStart(width, "0");
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return `${date} ${time}.${String(frac).padStart(9, "0")}`;
}
