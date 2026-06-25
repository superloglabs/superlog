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
const NANOS_PER_SECOND = 1_000_000_000n;

export function otlpLogsToRows(payload: OtlpLogsExport, projectId: string): OtelLogRow[] {
  const rows: OtelLogRow[] = [];
  for (const rl of payload.resourceLogs ?? []) {
    const resourceMap = kvListToMap(rl.resource?.attributes);
    const serviceName = resourceMap["service.name"] ?? "";
    const resourceAttributes = stripSuperlog(resourceMap);
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
          LogAttributes: stripSuperlog(kvListToMap(lr.attributes)),
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

export function otlpTracesToRows(payload: OtlpTracesExport, projectId: string): OtelTraceRow[] {
  const rows: OtelTraceRow[] = [];
  for (const rs of payload.resourceSpans ?? []) {
    const resourceMap = kvListToMap(rs.resource?.attributes);
    const serviceName = resourceMap["service.name"] ?? "";
    const resourceAttributes = stripSuperlog(resourceMap);
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
          SpanAttributes: stripSuperlog(kvListToMap(span.attributes)),
          Duration: (end > start ? end - start : 0n).toString(),
          StatusCode: STATUS_CODES[span.status?.code ?? 0] ?? "Unset",
          StatusMessage: span.status?.message ?? "",
          "Events.Timestamp": events.map((e) => nanosToClickHouseDateTime64(e.timeUnixNano ?? 0)),
          "Events.Name": events.map((e) => e.name ?? ""),
          "Events.Attributes": events.map((e) => stripSuperlog(kvListToMap(e.attributes))),
          "Links.TraceId": links.map((l) => toHex(l.traceId)),
          "Links.SpanId": links.map((l) => toHex(l.spanId)),
          "Links.TraceState": links.map((l) => l.traceState ?? ""),
          "Links.Attributes": links.map((l) => stripSuperlog(kvListToMap(l.attributes))),
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

function stripSuperlog(map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    if (k.startsWith("superlog.")) continue;
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
  if (v.arrayValue) return JSON.stringify((v.arrayValue.values ?? []).map(anyValueToJson));
  if (v.kvlistValue) return JSON.stringify(anyValueToJson(v));
  return "";
}

function anyValueToJson(v: OtlpAnyValue | undefined): unknown {
  if (!v) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.boolValue !== undefined) return v.boolValue;
  // Nested ints serialize as numeric JSON tokens (e.g. [1,2], not ["1","2"]) to
  // match the collector. intValue arrives as a string (OTLP/JSON int64, and the
  // protobuf decoder's longs:String); coerce so JSON.stringify emits a number.
  // Values beyond 2^53 can't be represented exactly in JSON either way.
  if (v.intValue !== undefined) return typeof v.intValue === "string" ? Number(v.intValue) : v.intValue;
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.bytesValue !== undefined) return bytesToBase64(v.bytesValue);
  if (v.arrayValue) return (v.arrayValue.values ?? []).map(anyValueToJson);
  if (v.kvlistValue) {
    const obj: Record<string, unknown> = {};
    for (const kv of v.kvlistValue.values ?? []) {
      if (kv.key === undefined || kv.key === null) continue;
      obj[kv.key] = anyValueToJson(kv.value);
    }
    return obj;
  }
  return null;
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
