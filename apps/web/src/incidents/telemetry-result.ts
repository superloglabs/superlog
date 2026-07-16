// Pure helpers for turning a stored agent telemetry tool call (an
// `agent.mcp_tool_use` of query_metrics/query_logs/query_traces, paired with its
// `agent.mcp_tool_result`) into widget-ready data.
//
// The agent's MCP query tools return a JSON array of rows. The recorded event
// stores that array, or a valid row-bounded prefix plus truncation metadata when
// the response is too large. We render the recorded result rather than re-running
// the query — it survives ClickHouse retention and avoids cross-project scope
// issues (the explore endpoints also can't express span_attrs/log_attrs filters
// the MCP tools accept, so a live re-run would be lossy).

import type { LogRow, MetricSeriesRow } from "../api.ts";
import { parseAbsoluteRange } from "../design/range-url.ts";

export type TelemetryKind = "metrics" | "logs" | "traces";

export type TraceTableRow = {
  timestamp: string;
  service: string;
  span_name: string;
  status_code: string;
  duration_ms: number;
  trace_id: string;
};

export type ToolRange = { since?: string; until?: string } | undefined;

export type TelemetryResultState = "complete" | "truncated" | "missing" | "invalid";

export type ParsedTelemetryResult = {
  rows: Record<string, unknown>[];
  state: TelemetryResultState;
  originalRowCount: number | null;
};

export type TelemetryResultMetadata = {
  truncated?: boolean;
  originalRowCount?: number;
};

export function telemetryToolKind(name: string | undefined): TelemetryKind | null {
  switch (name) {
    case "query_metrics":
      return "metrics";
    case "query_logs":
      return "logs";
    case "query_traces":
      return "traces";
    default:
      return null;
  }
}

/** Parse the JSON array of result rows the agent recorded. Null-safe; returns []
 *  for empty results, scalars, objects, or unparseable text. */
export function parseResultRows(text: string | null | undefined): Record<string, unknown>[] {
  return parseTelemetryResult(text).rows;
}

export function parseTelemetryResult(
  text: string | null | undefined,
  metadata: TelemetryResultMetadata = {},
): ParsedTelemetryResult {
  if (!text) return { rows: [], state: "missing", originalRowCount: null };
  const trimmed = text.trim();
  if (!trimmed.startsWith("[")) {
    return { rows: [], state: "invalid", originalRowCount: null };
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      return { rows: [], state: "invalid", originalRowCount: null };
    }
    const rows = parsed.filter(
      (row): row is Record<string, unknown> => !!row && typeof row === "object",
    );
    return {
      rows,
      state: metadata.truncated ? "truncated" : "complete",
      originalRowCount: metadata.originalRowCount ?? (metadata.truncated ? null : rows.length),
    };
  } catch {
    return {
      rows: [],
      state: trimmed.endsWith("...") ? "truncated" : "invalid",
      originalRowCount: null,
    };
  }
}

export function telemetryResultNotice(
  state: TelemetryResultState,
  storedRowCount: number,
  originalRowCount: number | null,
): string | null {
  if (state === "complete") return null;
  if (state === "missing") return "The query result was not recorded.";
  if (state === "invalid") return "The recorded result could not be displayed.";
  if (storedRowCount === 0) {
    return "The recorded result was truncated before it could be displayed.";
  }
  const total = originalRowCount === null ? "more" : String(originalRowCount);
  return `Showing ${storedRowCount} of ${total} recorded rows; the stored result was truncated.`;
}

/** ClickHouse "YYYY-MM-DD HH:MM:SS.nanos" (or ISO) → "YYYY-MM-DD HH:MM:SS",
 *  the bucket format the chart's axis formatter expects (it appends "Z"). */
export function normalizeBucket(ts: string): string {
  return ts.replace("T", " ").replace("Z", "").slice(0, 19);
}

function numField(row: Record<string, unknown>, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

function strField(row: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "string") return v;
  }
  return "";
}

/** Metric points → chart series rows, value falling back sum→count for
 *  histograms/summaries. Drops rows missing a timestamp or value; sorts ascending. */
export function toMetricRows(rows: Record<string, unknown>[], group: string): MetricSeriesRow[] {
  return rows
    .map((r) => {
      const tsRaw = r.timestamp;
      const value = numField(r, "value", "sum", "count");
      if (typeof tsRaw !== "string" || value === null) return null;
      return { bucket: normalizeBucket(tsRaw), group, value };
    })
    .filter((r): r is MetricSeriesRow => r !== null)
    .sort((a, b) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0));
}

/** Log result rows → LogRow shape the LogsTable renders. */
export function toLogRows(rows: Record<string, unknown>[]): LogRow[] {
  return rows.map((r) => ({
    timestamp: strField(r, "timestamp"),
    service: strField(r, "service"),
    severity: strField(r, "severity"),
    severity_number: numField(r, "severity_number") ?? 0,
    body: strField(r, "body", "exception_message"),
    trace_id: strField(r, "trace_id"),
    span_id: strField(r, "span_id"),
    log_attrs: (r.log_attrs as Record<string, string>) ?? {},
    resource_attrs: (r.resource_attrs as Record<string, string>) ?? {},
  }));
}

/** Trace/span result rows → the columns TracesTable renders. */
export function toTraceRows(rows: Record<string, unknown>[]): TraceTableRow[] {
  return rows.map((r) => ({
    timestamp: strField(r, "timestamp"),
    service: strField(r, "service"),
    span_name: strField(r, "span_name"),
    status_code: strField(r, "status_code"),
    duration_ms: numField(r, "duration_ms") ?? 0,
    trace_id: strField(r, "trace_id"),
  }));
}

/** Build a deep link into the Explore page that pre-fills the filters from a
 *  recorded agent query, so the widget's "Open in Explore" lands on the same
 *  view the agent saw instead of the bare /explore page.
 *
 *  Explore addresses its filters through the URL (see `Explore.tsx`): `attr`
 *  (repeatable `key=value` resource attributes, with the service modeled as the
 *  `service.name` attribute), `sev` (logs), `status` (traces), and `metric`
 *  (metrics). The MCP query tools also accept span_name / free-text search /
 *  span_attrs / log_attrs, none of which Explore can express in its URL, so
 *  those are dropped rather than mismapped. The time range is carried as
 *  `since` / `until` when it's an absolute window; relative ClickHouse
 *  expressions (`now() - …`) are dropped because Explore can't reconstruct
 *  them from the URL. */
export function exploreHref(kind: TelemetryKind, input: Record<string, unknown>): string {
  const params = new URLSearchParams();

  if (typeof input.service === "string" && input.service) {
    params.append("attr", `service.name=${input.service}`);
  }
  const resourceAttrs = input.resource_attrs;
  if (Array.isArray(resourceAttrs)) {
    for (const a of resourceAttrs as { key?: unknown; value?: unknown }[]) {
      if (a && typeof a.key === "string" && a.key) {
        params.append("attr", `${a.key}=${typeof a.value === "string" ? a.value : ""}`);
      }
    }
  }

  if (kind === "logs" && typeof input.severity === "string" && input.severity) {
    params.set("sev", input.severity);
  }
  if (kind === "traces" && typeof input.status_code === "string" && input.status_code) {
    params.set("status", input.status_code);
  }
  if (kind === "metrics" && typeof input.metric_name === "string" && input.metric_name) {
    params.set("metric", input.metric_name);
  }

  // Pin the exact window the agent queried, but only when it's an absolute
  // range — the MCP tools also accept ClickHouse expressions (`now() - …`),
  // which Explore can't reconstruct from the URL.
  const range = input.range as { since?: unknown; until?: unknown } | undefined;
  const absolute = range
    ? parseAbsoluteRange(
        typeof range.since === "string" ? range.since : null,
        typeof range.until === "string" ? range.until : null,
      )
    : null;
  if (absolute) {
    params.set("since", absolute.since);
    params.set("until", absolute.until);
  }

  const qs = params.toString();
  return qs ? `/explore/${kind}?${qs}` : `/explore/${kind}`;
}

function isoToHm(s: string): string | null {
  // Accept ISO 8601 only (so ClickHouse exprs like "now() - INTERVAL 2 HOUR" pass through).
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) return null;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** Human window label for the widget footer. ISO ranges render as "HH:MM – HH:MM
 *  UTC"; ClickHouse time expressions are shown verbatim. */
export function formatRangeLabel(range: ToolRange): string {
  if (!range || (!range.since && !range.until)) return "";
  const since = range.since ?? "";
  const until = range.until ?? "";
  const sinceHm = isoToHm(since);
  const untilHm = isoToHm(until);
  if (sinceHm && untilHm) return `${sinceHm} – ${untilHm} UTC`;
  return `${since} → ${until}`;
}
