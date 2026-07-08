// Render Log Stream (HTTPS destination) → OTLP JSON. Render pushes each
// workspace's logs to the endpoint the connector registered
// (/render/stream/logs) as JSON over HTTPS. The payload schema for custom
// HTTPS destinations is not formally documented, so the parser is permissive:
// it accepts an array, a single object, an enveloped `{logs: [...]}`, or
// NDJSON, and maps the field names Render uses elsewhere (its /v1/logs API
// shape with a `labels` name/value array, and flat syslog-annotation-style
// fields like appname/service/instance). Unknown scalar fields ride along as
// render.attr.* so nothing is silently dropped.

type OtlpAnyValue = {
  stringValue?: string;
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
};

type OtlpKeyValue = { key: string; value: OtlpAnyValue };

export type RenderStreamLogRecord = Record<string, unknown>;

export type RenderStreamOtlpLogsExport = {
  resourceLogs: Array<{
    resource: { attributes: OtlpKeyValue[] };
    scopeLogs: Array<{
      scope: { name: string };
      logRecords: Array<{
        timeUnixNano: string;
        observedTimeUnixNano: string;
        severityText: string;
        severityNumber: number;
        body: OtlpAnyValue;
        attributes: OtlpKeyValue[];
      }>;
    }>;
  }>;
};

const LEVEL_TO_SEVERITY: Record<string, { text: string; number: number }> = {
  trace: { text: "TRACE", number: 1 },
  debug: { text: "DEBUG", number: 5 },
  info: { text: "INFO", number: 9 },
  notice: { text: "INFO", number: 10 },
  warning: { text: "WARN", number: 13 },
  warn: { text: "WARN", number: 13 },
  error: { text: "ERROR", number: 17 },
  err: { text: "ERROR", number: 17 },
  crit: { text: "FATAL", number: 21 },
  fatal: { text: "FATAL", number: 21 },
};

export function parseRenderLogStreamBody(
  body: Buffer,
  contentType: string,
): RenderStreamLogRecord[] {
  const text = body.toString("utf8").trim();
  if (!text) return [];
  const lower = contentType.toLowerCase();
  if (lower.includes("ndjson") || lower.includes("x-ndjson")) {
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => coerceRecord(JSON.parse(line)));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Some senders use content-type application/json for newline-delimited
    // payloads anyway — retry as NDJSON before giving up.
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => coerceRecord(JSON.parse(line)));
  }
  if (Array.isArray(parsed)) return parsed.map(coerceRecord);
  if (parsed && typeof parsed === "object") {
    const envelope = parsed as { logs?: unknown };
    if (Array.isArray(envelope.logs)) return envelope.logs.map(coerceRecord);
    return [coerceRecord(parsed)];
  }
  throw new Error("invalid Render log stream payload");
}

export function renderStreamLogsToOtlp(
  logs: RenderStreamLogRecord[],
): RenderStreamOtlpLogsExport {
  return {
    resourceLogs: logs.map((log) => {
      const labels = labelMap(log);
      const nanos = timestampToNanos(log.timestamp ?? log.time ?? log.ts ?? labels.timestamp);
      return {
        resource: { attributes: resourceAttributes(log, labels) },
        scopeLogs: [
          {
            scope: { name: "render.stream.logs" },
            logRecords: [
              {
                timeUnixNano: nanos,
                observedTimeUnixNano: nanos,
                ...severity(labels.level ?? log.level ?? log.severity ?? log.status),
                body: { stringValue: messageBody(log) },
                attributes: logAttributes(log, labels),
              },
            ],
          },
        ],
      };
    }),
  };
}

function coerceRecord(value: unknown): RenderStreamLogRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid Render log stream record");
  }
  return value as RenderStreamLogRecord;
}

// Render's own log objects carry metadata as labels: [{name, value}]
// (resource, instance, level, type, …). Flatten to a dict when present.
function labelMap(log: RenderStreamLogRecord): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(log.labels)) {
    for (const label of log.labels) {
      if (
        label &&
        typeof label === "object" &&
        typeof (label as { name?: unknown }).name === "string" &&
        typeof (label as { value?: unknown }).value === "string"
      ) {
        out[(label as { name: string }).name] = (label as { value: string }).value;
      }
    }
  }
  return out;
}

function resourceAttributes(
  log: RenderStreamLogRecord,
  labels: Record<string, string>,
): OtlpKeyValue[] {
  // Prefer human-readable slugs (syslog annotations use the service slug as
  // APP-NAME) over srv- ids for service.name; keep the id as an attribute.
  const serviceName =
    stringOf(log.service) ??
    stringOf(log.serviceName) ??
    stringOf(log.app) ??
    stringOf(log.appname) ??
    labels.service ??
    labels.app ??
    labels.resource ??
    stringOf(log.resource) ??
    "render";
  const serviceId =
    labels.resource ?? stringOf(log.resource) ?? stringOf(log.serviceId) ?? undefined;
  return [
    kv("service.name", serviceName),
    kv("telemetry.source", "render"),
    kv("render.service_id", serviceId),
    kv("render.service_type", labels.type ?? stringOf(log.type)),
  ].filter(isKv);
}

function logAttributes(
  log: RenderStreamLogRecord,
  labels: Record<string, string>,
): OtlpKeyValue[] {
  const attrs: Array<OtlpKeyValue | null> = [
    kv("render.log_id", stringOf(log.id)),
    kv("render.instance", labels.instance ?? stringOf(log.instance) ?? stringOf(log.hostname)),
  ];
  const claimed = new Set(["resource", "instance", "level", "type", "service", "app"]);
  for (const [name, value] of Object.entries(labels)) {
    if (!claimed.has(name)) attrs.push(kv(`render.attr.${name}`, value));
  }
  const claimedFields = new Set([
    "id",
    "message",
    "msg",
    "log",
    "text",
    "timestamp",
    "time",
    "ts",
    "level",
    "severity",
    "status",
    "labels",
    "service",
    "serviceName",
    "app",
    "appname",
    "resource",
    "serviceId",
    "instance",
    "hostname",
    "type",
  ]);
  for (const [name, value] of Object.entries(log)) {
    if (claimedFields.has(name)) continue;
    if (value === null || typeof value === "object") continue;
    attrs.push(kv(`render.attr.${name}`, value));
  }
  return attrs.filter(isKv);
}

function messageBody(log: RenderStreamLogRecord): string {
  for (const field of ["message", "msg", "log", "text"]) {
    const value = log[field];
    if (typeof value === "string") return value;
  }
  return JSON.stringify(log);
}

function severity(value: unknown): { severityText: string; severityNumber: number } {
  const mapped = typeof value === "string" ? LEVEL_TO_SEVERITY[value.toLowerCase()] : undefined;
  return { severityText: mapped?.text ?? "", severityNumber: mapped?.number ?? 0 };
}

// Timestamps arrive as RFC3339 strings or epoch numbers of unknown unit —
// disambiguate by magnitude (s ~1e9, ms ~1e12, µs ~1e15, ns ~1e18).
function timestampToNanos(value: unknown): string {
  if (typeof value === "string" && value) {
    if (/^\d+$/.test(value)) return timestampToNanos(Number(value));
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) {
      // Preserve sub-millisecond fraction when present.
      const match = value.match(/\.(\d{4,9})(?:Z|[+-])/);
      const base = BigInt(ms) * 1_000_000n - BigInt(ms % 1000) * 1_000_000n;
      if (match?.[1]) return `${base + BigInt(match[1].padEnd(9, "0"))}`;
      return `${BigInt(ms) * 1_000_000n}`;
    }
    return "0";
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    if (value > 1e17) return `${BigInt(Math.trunc(value))}`;
    if (value > 1e14) return `${BigInt(Math.trunc(value)) * 1_000n}`;
    if (value > 1e11) return `${BigInt(Math.trunc(value)) * 1_000_000n}`;
    return `${BigInt(Math.trunc(value)) * 1_000_000_000n}`;
  }
  return "0";
}

function kv(key: string, value: unknown): OtlpKeyValue | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value ? { key, value: { stringValue: value } } : null;
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { key, value: { intValue: String(value) } }
      : { key, value: { doubleValue: value } };
  }
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  return { key, value: { stringValue: String(value) } };
}

function isKv(value: OtlpKeyValue | null): value is OtlpKeyValue {
  return value !== null;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
