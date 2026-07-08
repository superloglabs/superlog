// Render → OTLP transforms plus the puller's cursor arithmetic. Pure
// functions only; the worker-side puller wires them to IO. The OTLP JSON
// shapes mirror the Railway connector's.

import {
  type RenderLog,
  type RenderMetricKind,
  type RenderMetricSeries,
  seriesResourceId,
} from "./client.js";

type OtlpAnyValue = {
  stringValue?: string;
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
};

type OtlpKeyValue = { key: string; value: OtlpAnyValue };

export type RenderOtlpLogsExport = {
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

export type RenderOtlpMetricsExport = {
  resourceMetrics: Array<{
    resource: { attributes: OtlpKeyValue[] };
    scopeMetrics: Array<{
      scope: { name: string };
      metrics: Array<{
        name: string;
        unit: string;
        gauge: {
          dataPoints: Array<{
            timeUnixNano: string;
            asDouble: number;
            attributes?: OtlpKeyValue[];
          }>;
        };
      }>;
    }>;
  }>;
};

/** Names resolved from inventory so telemetry is labeled, not just id-tagged. */
export type RenderNameContext = {
  serviceNamesById: Record<string, string>;
  ownerId: string;
  ownerName: string;
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
 * RFC3339 → epoch nanos as bigint, preserving Render's sub-millisecond
 * precision (Date.parse alone truncates to ms). Null on unparseable input.
 */
export function rfc3339ToNanos(timestamp: string): bigint | null {
  const match = timestamp.match(/^(.*?)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$/);
  if (!match) return null;
  const [, base, fraction, zone] = match;
  const ms = Date.parse(`${base}${zone}`);
  if (!Number.isFinite(ms)) return null;
  const nanosFraction = BigInt((fraction ?? "").padEnd(9, "0") || "0");
  return BigInt(ms) * 1_000_000n - BigInt(ms % 1000) * 1_000_000n + nanosFraction;
}

// Strip ANSI color/control sequences Render passes through from app stdout.
// Control-char regex is intentional here.
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes start with ESC (\u001b)
const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

// Render's log labels: `resource` and `level` shape the OTLP record; the rest
// ride along as attributes under render.attr.*.
function logLabel(log: RenderLog, name: string): string | null {
  return log.labels.find((l) => l.name === name)?.value ?? null;
}

export function renderLogsToOtlp(logs: RenderLog[], ctx: RenderNameContext): RenderOtlpLogsExport {
  return {
    resourceLogs: logs.map((log) => {
      const resourceId = logLabel(log, "resource");
      const serviceName = (resourceId && ctx.serviceNamesById[resourceId]) || "render";
      const nanos = rfc3339ToNanos(log.timestamp) ?? 0n;
      return {
        resource: {
          attributes: [
            kv("service.name", serviceName),
            kv("telemetry.source", "render"),
            kv("render.owner_id", ctx.ownerId),
            kv("render.owner_name", ctx.ownerName),
            kv("render.service_id", resourceId),
          ].filter(isKv),
        },
        scopeLogs: [
          {
            scope: { name: "render.pull.logs" },
            logRecords: [
              {
                timeUnixNano: nanos.toString(),
                observedTimeUnixNano: nanos.toString(),
                ...severity(logLabel(log, "level")),
                body: { stringValue: stripAnsi(log.message) },
                attributes: [
                  kv("render.log_id", log.id),
                  ...log.labels
                    .filter((l) => l.name !== "resource" && l.name !== "level")
                    .map((l) => kv(`render.attr.${l.name}`, l.value)),
                ].filter(isKv),
              },
            ],
          },
        ],
      };
    }),
  };
}

// kind → OTLP gauge name + fallback unit (the API reports a unit per series;
// it wins when present). Values are forwarded as-is in Render's units.
const KIND_METRICS: Record<RenderMetricKind, { name: string; unit: string }> = {
  cpu: { name: "render.cpu.usage", unit: "{cpu}" },
  memory: { name: "render.memory.usage", unit: "By" },
  "instance-count": { name: "render.instance.count", unit: "{instance}" },
  bandwidth: { name: "render.bandwidth.usage", unit: "By" },
  "disk-usage": { name: "render.disk.usage", unit: "By" },
};

export function renderMetricsToOtlp(
  kind: RenderMetricKind,
  series: RenderMetricSeries[],
  ctx: RenderNameContext,
): RenderOtlpMetricsExport {
  const mapped = KIND_METRICS[kind];
  const byResource = new Map<string, RenderMetricSeries[]>();
  for (const s of series) {
    if (s.values.length === 0) continue;
    const resourceId = seriesResourceId(s) ?? "unknown";
    const group = byResource.get(resourceId);
    if (group) group.push(s);
    else byResource.set(resourceId, [s]);
  }
  const resourceMetrics = [...byResource.entries()].map(([resourceId, group]) => {
    const serviceName = (resourceId !== "unknown" && ctx.serviceNamesById[resourceId]) || "render";
    return {
      resource: {
        attributes: [
          kv("service.name", serviceName),
          kv("telemetry.source", "render"),
          kv("render.owner_id", ctx.ownerId),
          kv("render.owner_name", ctx.ownerName),
          kv("render.service_id", resourceId === "unknown" ? null : resourceId),
        ].filter(isKv),
      },
      scopeMetrics: [
        {
          scope: { name: "render.pull.metrics" },
          metrics: group.map((s) => ({
            name: mapped.name,
            unit: s.unit ?? mapped.unit,
            gauge: {
              dataPoints: s.values.map((v) => {
                const nanos = rfc3339ToNanos(v.timestamp) ?? 0n;
                // Series-distinguishing labels (e.g. instance) ride on the
                // data points so per-instance series don't collapse.
                const extra = s.labels
                  .filter((l) => l.field !== "resource" && l.field !== "service")
                  .map((l) => kv(`render.${l.field}`, l.value))
                  .filter(isKv);
                return {
                  timeUnixNano: nanos.toString(),
                  asDouble: v.value,
                  ...(extra.length > 0 ? { attributes: extra } : {}),
                };
              }),
            },
          })),
        },
      ],
    };
  });
  return { resourceMetrics };
}

// ---------------------------------------------------------------------------
// Cursors — dedupe on re-delivery (start bounds are not trusted to be
// exclusive) and never move backwards. Log cursors are keyed by the puller's
// region group; metrics cursors by series identity in epoch seconds.
// ---------------------------------------------------------------------------

/**
 * A log cursor entry: the newest forwarded timestamp plus the ids of the
 * lines AT that timestamp. A pass can end (page budget, page boundary) in the
 * middle of a group of lines sharing one timestamp — a timestamp-only cursor
 * with a strict `>` filter would drop the unseen remainder of that group on
 * the next pass, so equal-timestamp lines are re-read and deduped by id
 * instead. Plain strings are the pre-ids shape, still accepted on read.
 */
export type RenderLogCursorEntry = { ts: string; ids: string[] };
export type RenderLogCursor = Record<string, RenderLogCursorEntry | string>;

export function logCursorTs(entry: RenderLogCursorEntry | string | undefined): string | null {
  if (!entry) return null;
  return typeof entry === "string" ? entry : entry.ts;
}

function logCursorIds(entry: RenderLogCursorEntry | string | undefined): string[] {
  return typeof entry === "object" && entry !== null ? entry.ids : [];
}

export function filterLogsAfterCursor(
  cursor: RenderLogCursor,
  groupKey: string,
  logs: RenderLog[],
): RenderLog[] {
  const entry = cursor[groupKey];
  const last = logCursorTs(entry);
  if (!last) return logs;
  const lastNanos = rfc3339ToNanos(last);
  if (lastNanos === null) return logs;
  const seenIds = new Set(logCursorIds(entry));
  return logs.filter((log) => {
    const nanos = rfc3339ToNanos(log.timestamp);
    if (nanos === null) return false;
    if (nanos > lastNanos) return true;
    // Lines sharing the boundary timestamp are fresh unless their id was
    // already forwarded. A boundary line without an id can't be deduped, so
    // treat it as seen rather than re-forwarding it every pass.
    return nanos === lastNanos && log.id !== null && !seenIds.has(log.id);
  });
}

export function advanceLogCursor(
  cursor: RenderLogCursor,
  groupKey: string,
  logs: RenderLog[],
): RenderLogCursor {
  const previous = cursor[groupKey];
  let maxTimestamp = logCursorTs(previous);
  let maxNanos = maxTimestamp ? rfc3339ToNanos(maxTimestamp) : null;
  for (const log of logs) {
    const nanos = rfc3339ToNanos(log.timestamp);
    if (nanos === null) continue;
    if (maxNanos === null || nanos > maxNanos) {
      maxNanos = nanos;
      maxTimestamp = log.timestamp;
    }
  }
  if (maxTimestamp == null || maxNanos == null) return cursor;
  // Collect ids at the boundary timestamp; keep the previous entry's ids when
  // the boundary didn't move so successive partial reads accumulate.
  const ids = new Set(
    logCursorTs(previous) !== null && rfc3339ToNanos(logCursorTs(previous) ?? "") === maxNanos
      ? logCursorIds(previous)
      : [],
  );
  for (const log of logs) {
    if (log.id !== null && rfc3339ToNanos(log.timestamp) === maxNanos) ids.add(log.id);
  }
  return { ...cursor, [groupKey]: { ts: maxTimestamp, ids: [...ids] } };
}

function timestampToEpochSeconds(timestamp: string): number | null {
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

/**
 * Stable cursor key for one metric series: resource + kind + every
 * distinguishing label (e.g. instance). Keying by resource alone would let a
 * fast instance's samples advance the cursor past a lagging instance's — the
 * laggard's points would then be dropped as already-seen.
 */
export function seriesCursorKey(
  resourceId: string,
  kind: RenderMetricKind,
  series: RenderMetricSeries,
): string {
  const extras = series.labels
    .filter((l) => l.field !== "resource" && l.field !== "service")
    .map((l) => `${l.field}=${l.value}`)
    .sort()
    .join(",");
  return extras ? `${resourceId}:${kind}:${extras}` : `${resourceId}:${kind}`;
}

export function filterSeriesAfterCursor(
  cursor: Record<string, number>,
  key: string,
  series: RenderMetricSeries[],
): RenderMetricSeries[] {
  const last = cursor[key];
  if (last === undefined) return series;
  return series
    .map((s) => ({
      ...s,
      values: s.values.filter((v) => {
        const sec = timestampToEpochSeconds(v.timestamp);
        return sec !== null && sec > last;
      }),
    }))
    .filter((s) => s.values.length > 0);
}

export function advanceSeriesCursor(
  cursor: Record<string, number>,
  key: string,
  series: RenderMetricSeries[],
): Record<string, number> {
  let max = cursor[key] ?? null;
  for (const s of series) {
    for (const v of s.values) {
      const sec = timestampToEpochSeconds(v.timestamp);
      if (sec === null) continue;
      if (max === null || sec > max) max = sec;
    }
  }
  if (max == null) return cursor;
  return { ...cursor, [key]: max };
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
