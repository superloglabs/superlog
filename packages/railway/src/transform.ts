// Railway → OTLP transforms plus the puller's cursor arithmetic. Pure
// functions only; the worker-side puller wires them to IO. The OTLP JSON
// shapes mirror the Vercel log-drain adapter's.

import type { RailwayLog, RailwayMetricsResult } from "./graphql.js";

type OtlpAnyValue = {
  stringValue?: string;
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
};

type OtlpKeyValue = { key: string; value: OtlpAnyValue };

export type RailwayOtlpLogsExport = {
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

export type RailwayOtlpMetricsExport = {
  resourceMetrics: Array<{
    resource: { attributes: OtlpKeyValue[] };
    scopeMetrics: Array<{
      scope: { name: string };
      metrics: Array<{
        name: string;
        unit: string;
        gauge: { dataPoints: Array<{ timeUnixNano: string; asDouble: number }> };
      }>;
    }>;
  }>;
};

/** Names resolved from inventory so telemetry is labeled, not just id-tagged. */
export type RailwayNameContext = {
  serviceNamesById: Record<string, string>;
  projectId: string;
  projectName: string;
  environmentId: string;
  environmentName: string;
};

const SEVERITY: Record<string, { text: string; number: number }> = {
  trace: { text: "TRACE", number: 1 },
  debug: { text: "DEBUG", number: 5 },
  info: { text: "INFO", number: 9 },
  warning: { text: "WARN", number: 13 },
  warn: { text: "WARN", number: 13 },
  error: { text: "ERROR", number: 17 },
  fatal: { text: "FATAL", number: 21 },
};

/**
 * RFC3339 → epoch nanos as bigint, preserving Railway's sub-millisecond
 * precision (Date.parse alone truncates to ms). Null on unparseable input.
 */
export function rfc3339ToNanos(timestamp: string): bigint | null {
  const match = timestamp.match(/^(.*?)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$/);
  if (!match) return null;
  const [, base, fraction, zone] = match;
  const ms = Date.parse(`${base}${zone}`);
  if (!Number.isFinite(ms)) return null;
  const nanosFraction = BigInt((fraction ?? "").padEnd(9, "0") || "0");
  return BigInt(ms) * 1_000_000n - (BigInt(ms % 1000) * 1_000_000n) + nanosFraction;
}

// Strip ANSI color/control sequences Railway passes through from app stdout.
// Control-char regex is intentional here.
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes start with ESC (\u001b)
const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

export function railwayLogsToOtlp(
  logs: RailwayLog[],
  ctx: RailwayNameContext,
): RailwayOtlpLogsExport {
  return {
    resourceLogs: logs.map((log) => {
      const serviceId = log.tags?.serviceId ?? null;
      const serviceName = (serviceId && ctx.serviceNamesById[serviceId]) || "railway";
      const nanos = rfc3339ToNanos(log.timestamp) ?? 0n;
      return {
        resource: {
          attributes: [
            kv("service.name", serviceName),
            kv("telemetry.source", "railway"),
            kv("railway.project_id", ctx.projectId),
            kv("railway.project_name", ctx.projectName),
            kv("railway.environment_id", ctx.environmentId),
            kv("railway.environment_name", ctx.environmentName),
            kv("railway.service_id", serviceId),
          ].filter(isKv),
        },
        scopeLogs: [
          {
            scope: { name: "railway.pull.logs" },
            logRecords: [
              {
                timeUnixNano: nanos.toString(),
                observedTimeUnixNano: nanos.toString(),
                ...severity(log.severity),
                body: { stringValue: stripAnsi(log.message) },
                attributes: [
                  kv("railway.deployment_id", log.tags?.deploymentId),
                  kv("railway.deployment_instance_id", log.tags?.deploymentInstanceId),
                  kv("railway.snapshot_id", log.tags?.snapshotId),
                  ...log.attributes.map((a) => kv(`railway.attr.${a.key}`, a.value)),
                ].filter(isKv),
              },
            ],
          },
        ],
      };
    }),
  };
}

// measurement → OTLP gauge name + unit. Values arrive in Railway's units
// (vCPU cores, gigabytes); forwarded as-is with explicit units.
const MEASUREMENT_METRICS: Record<string, { name: string; unit: string }> = {
  CPU_USAGE: { name: "railway.cpu.usage", unit: "{vCPU}" },
  CPU_LIMIT: { name: "railway.cpu.limit", unit: "{vCPU}" },
  MEMORY_USAGE_GB: { name: "railway.memory.usage", unit: "GBy" },
  MEMORY_LIMIT_GB: { name: "railway.memory.limit", unit: "GBy" },
  NETWORK_RX_GB: { name: "railway.network.rx", unit: "GBy" },
  NETWORK_TX_GB: { name: "railway.network.tx", unit: "GBy" },
  DISK_USAGE_GB: { name: "railway.disk.usage", unit: "GBy" },
  EPHEMERAL_DISK_USAGE_GB: { name: "railway.ephemeral_disk.usage", unit: "GBy" },
};

export function railwayMetricsToOtlp(
  results: RailwayMetricsResult[],
  ctx: RailwayNameContext & { serviceId?: string },
): RailwayOtlpMetricsExport {
  const serviceId = ctx.serviceId ?? results.find((r) => r.tags?.serviceId)?.tags?.serviceId ?? null;
  const serviceName = (serviceId && ctx.serviceNamesById[serviceId]) || "railway";
  const metrics = results
    .map((result) => {
      const mapped = MEASUREMENT_METRICS[result.measurement];
      if (!mapped || result.values.length === 0) return null;
      return {
        name: mapped.name,
        unit: mapped.unit,
        gauge: {
          dataPoints: result.values.map((v) => ({
            timeUnixNano: `${BigInt(Math.trunc(v.ts)) * 1_000_000_000n}`,
            asDouble: v.value,
          })),
        },
      };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);
  if (metrics.length === 0) return { resourceMetrics: [] };
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [
            kv("service.name", serviceName),
            kv("telemetry.source", "railway"),
            kv("railway.project_id", ctx.projectId),
            kv("railway.project_name", ctx.projectName),
            kv("railway.environment_id", ctx.environmentId),
            kv("railway.environment_name", ctx.environmentName),
            kv("railway.service_id", serviceId),
          ].filter(isKv),
        },
        scopeMetrics: [{ scope: { name: "railway.pull.metrics" }, metrics }],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Cursors — dedupe on re-delivery (subscription reconnects replay the last
// line; afterDate bounds are not trusted to be exclusive) and never move
// backwards.
// ---------------------------------------------------------------------------

export function filterLogsAfterCursor(
  cursor: Record<string, string>,
  environmentId: string,
  logs: RailwayLog[],
): RailwayLog[] {
  const last = cursor[environmentId];
  if (!last) return logs;
  const lastNanos = rfc3339ToNanos(last);
  if (lastNanos === null) return logs;
  return logs.filter((log) => {
    const nanos = rfc3339ToNanos(log.timestamp);
    return nanos !== null && nanos > lastNanos;
  });
}

export function advanceLogCursor(
  cursor: Record<string, string>,
  environmentId: string,
  logs: RailwayLog[],
): Record<string, string> {
  let maxTimestamp = cursor[environmentId] ?? null;
  let maxNanos = maxTimestamp ? rfc3339ToNanos(maxTimestamp) : null;
  for (const log of logs) {
    const nanos = rfc3339ToNanos(log.timestamp);
    if (nanos === null) continue;
    if (maxNanos === null || nanos > maxNanos) {
      maxNanos = nanos;
      maxTimestamp = log.timestamp;
    }
  }
  if (maxTimestamp == null) return cursor;
  return { ...cursor, [environmentId]: maxTimestamp };
}

export function filterMetricsAfterCursor(
  cursor: Record<string, number>,
  serviceId: string,
  results: RailwayMetricsResult[],
): RailwayMetricsResult[] {
  const last = cursor[serviceId];
  if (last === undefined) return results;
  return results
    .map((r) => ({ ...r, values: r.values.filter((v) => v.ts > last) }))
    .filter((r) => r.values.length > 0);
}

export function advanceMetricsCursor(
  cursor: Record<string, number>,
  serviceId: string,
  results: RailwayMetricsResult[],
): Record<string, number> {
  let max = cursor[serviceId] ?? null;
  for (const r of results) {
    for (const v of r.values) {
      if (max === null || v.ts > max) max = v.ts;
    }
  }
  if (max == null) return cursor;
  return { ...cursor, [serviceId]: max };
}

// ---------------------------------------------------------------------------

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

function severity(value: string | null): { severityText: string; severityNumber: number } {
  const mapped = value ? SEVERITY[value.toLowerCase()] : undefined;
  return { severityText: mapped?.text ?? "", severityNumber: mapped?.number ?? 0 };
}
