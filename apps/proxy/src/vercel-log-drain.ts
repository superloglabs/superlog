type OtlpAnyValue = {
  stringValue?: string;
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values: OtlpAnyValue[] };
};

type OtlpKeyValue = { key: string; value: OtlpAnyValue };

type VercelLogRecord = Record<string, unknown> & {
  timestamp?: unknown;
  level?: unknown;
  message?: unknown;
  traceId?: unknown;
  spanId?: unknown;
  "trace.id"?: unknown;
  "span.id"?: unknown;
  projectName?: unknown;
  host?: unknown;
  projectId?: unknown;
  deploymentId?: unknown;
  source?: unknown;
  proxy?: unknown;
};

export type VercelOtlpLogsExport = {
  resourceLogs: Array<{
    resource: { attributes: OtlpKeyValue[] };
    scopeLogs: Array<{
      scope: { name: string };
      logRecords: Array<{
        timeUnixNano: string;
        observedTimeUnixNano: string;
        severityText: string;
        severityNumber: number;
        traceId?: string;
        spanId?: string;
        body: OtlpAnyValue;
        attributes: OtlpKeyValue[];
      }>;
    }>;
  }>;
};

const LEVEL_TO_SEVERITY: Record<string, { text: string; number: number }> = {
  info: { text: "INFO", number: 9 },
  warning: { text: "WARN", number: 13 },
  warn: { text: "WARN", number: 13 },
  error: { text: "ERROR", number: 17 },
  fatal: { text: "FATAL", number: 21 },
};

export function parseVercelLogDrainBody(body: Buffer, contentType: string): VercelLogRecord[] {
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
  const parsed = JSON.parse(text);
  if (Array.isArray(parsed)) return parsed.map(coerceRecord);
  return [coerceRecord(parsed)];
}

export function vercelLogsToOtlp(logs: VercelLogRecord[]): VercelOtlpLogsExport {
  return {
    resourceLogs: logs.map((log) => ({
      resource: { attributes: resourceAttributes(log) },
      scopeLogs: [
        {
          scope: { name: "vercel.drains.logs" },
          logRecords: [
            {
              timeUnixNano: timestampMillisToNanos(log.timestamp),
              observedTimeUnixNano: timestampMillisToNanos(log.timestamp),
              ...severity(log.level),
              traceId: hexId(log.traceId ?? log["trace.id"], 32),
              spanId: hexId(log.spanId ?? log["span.id"], 16),
              body: { stringValue: messageBody(log) },
              attributes: logAttributes(log),
            },
          ],
        },
      ],
    })),
  };
}

function coerceRecord(value: unknown): VercelLogRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid Vercel log record");
  }
  return value as VercelLogRecord;
}

function resourceAttributes(log: VercelLogRecord): OtlpKeyValue[] {
  const serviceName = stringValue(log.projectName) || stringValue(log.host) || "vercel";
  return [
    kv("service.name", serviceName),
    kv("telemetry.source", "vercel"),
    kv("vercel.project_id", log.projectId),
    kv("vercel.project_name", log.projectName),
    kv("vercel.host", log.host),
  ].filter(isKv);
}

function logAttributes(log: VercelLogRecord): OtlpKeyValue[] {
  const attrs: Array<OtlpKeyValue | null> = [
    kv("vercel.id", log.id),
    kv("vercel.deployment_id", log.deploymentId),
    kv("vercel.source", log.source),
    kv("vercel.build_id", log.buildId),
    kv("vercel.type", log.type),
    kv("vercel.entrypoint", log.entrypoint),
    kv("vercel.request_id", log.requestId),
    kv("vercel.environment", log.environment),
    kv("vercel.branch", log.branch),
    kv("vercel.execution_region", log.executionRegion),
    kv("http.route", log.path),
    kv("http.response.status_code", log.statusCode),
  ];

  if (log.proxy && typeof log.proxy === "object" && !Array.isArray(log.proxy)) {
    const proxy = log.proxy as Record<string, unknown>;
    attrs.push(
      kv("vercel.proxy.method", proxy.method),
      kv("vercel.proxy.host", proxy.host),
      kv("vercel.proxy.path", proxy.path),
      kv("vercel.proxy.region", proxy.region),
      kv("vercel.proxy.status_code", proxy.statusCode),
      kv("vercel.proxy.client_ip", proxy.clientIp),
      kv("vercel.proxy.scheme", proxy.scheme),
      kv("vercel.proxy.cache", proxy.vercelCache),
      kv("vercel.proxy.path_type", proxy.pathType),
      kv("vercel.proxy.user_agent", proxy.userAgent),
    );
  }

  return attrs.filter(isKv);
}

function severity(value: unknown): { severityText: string; severityNumber: number } {
  const mapped = typeof value === "string" ? LEVEL_TO_SEVERITY[value.toLowerCase()] : undefined;
  return { severityText: mapped?.text ?? "", severityNumber: mapped?.number ?? 0 };
}

function timestampMillisToNanos(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return `${BigInt(Math.trunc(value)) * 1_000_000n}`;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return `${BigInt(value) * 1_000_000n}`;
  }
  return "0";
}

function messageBody(log: VercelLogRecord): string {
  if (typeof log.message === "string") return log.message;
  if (log.message !== undefined && log.message !== null) return stringify(log.message);
  return stringify(log);
}

function hexId(value: unknown, length: 16 | 32): string | undefined {
  return typeof value === "string" && new RegExp(`^[0-9a-fA-F]{${length}}$`).test(value)
    ? value.toLowerCase()
    : undefined;
}

function kv(key: string, value: unknown): OtlpKeyValue | null {
  const otlpValue = anyValue(value);
  return otlpValue ? { key, value: otlpValue } : null;
}

function isKv(value: OtlpKeyValue | null): value is OtlpKeyValue {
  return value !== null;
}

function anyValue(value: unknown): OtlpAnyValue | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === "boolean") return { boolValue: value };
  return { stringValue: stringify(value) };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
