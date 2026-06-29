// Pure helpers for turning a stored agent telemetry tool call (an
// `agent.mcp_tool_use` of query_metrics/query_logs/query_traces, paired with its
// `agent.mcp_tool_result`) into widget-ready data.
//
// The agent's MCP query tools return a JSON array of rows; the worker persists
// that array verbatim in `incident_events.summary` of the result event. We render
// the agent's *recorded* result rather than re-running the query — it's faithful
// to what the agent saw, survives ClickHouse retention, and avoids cross-project
// scope issues (the explore endpoints also can't express span_attrs/log_attrs
// filters the MCP tools accept, so a live re-run would be lossy).

import type { LogRow, MetricSeriesRow } from "../api.ts";

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
  if (!text) return [];
  const trimmed = text.trim();
  if (!trimmed.startsWith("[")) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((r): r is Record<string, unknown> => !!r && typeof r === "object");
  } catch {
    return [];
  }
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
