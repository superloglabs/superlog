// Pure value-formatting + per-series summarization for dashboard chart widgets.
// Kept dependency-free (no react/api imports) so it runs under `tsx --test`,
// same as series-topn.ts.

/**
 * How a widget's numeric values should be rendered on the axis, in the tooltip,
 * and in the legend. `none` is a plain number; the rest carry a dimension so we
 * can auto-scale (15000 ms -> "15s") instead of showing raw magnitudes.
 */
export type WidgetUnit = "none" | "duration_ms" | "duration_s" | "bytes" | "percent";

export const WIDGET_UNITS: readonly WidgetUnit[] = [
  "none",
  "duration_ms",
  "duration_s",
  "bytes",
  "percent",
] as const;

/** Human labels for the widget editor's unit picker. */
export const WIDGET_UNIT_LABELS: Record<WidgetUnit, string> = {
  none: "number",
  duration_ms: "ms",
  duration_s: "seconds",
  bytes: "bytes",
  percent: "percent",
};

// The aggregations the legend headline can mirror — the same set as the API's
// MetricAggregation, plus the implicit "sum" used by count widgets. Declared
// locally so this module imports nothing.
export type SummaryAgg = "sum" | "avg" | "min" | "max" | "p95" | "p99";

/**
 * Collapse a series' per-bucket values into the single headline shown in the
 * legend, mirroring how the chart itself aggregates. Callers pass only the
 * buckets the series actually has data in (no zero-fill), so `avg`/`min` reflect
 * the real distribution rather than being dragged toward zero by empty buckets.
 */
export function summarizeSeries(values: number[], agg: SummaryAgg): number {
  if (values.length === 0) return 0;
  switch (agg) {
    case "sum":
      return values.reduce((a, b) => a + b, 0);
    case "avg":
      return values.reduce((a, b) => a + b, 0) / values.length;
    case "min":
      return values.reduce((a, b) => (b < a ? b : a));
    case "max":
      return values.reduce((a, b) => (b > a ? b : a));
    case "p95":
      return percentile(values, 0.95);
    case "p99":
      return percentile(values, 0.99);
  }
}

// Nearest-rank percentile. Per-bucket p95s aren't true global p95, but as a
// legend headline this matches the chart's own approximation.
function percentile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[rank - 1] ?? sorted[sorted.length - 1] ?? 0;
}

// Exact below the threshold (so axis ticks like 60000 read normally); compact
// above it so the legend doesn't become a wall of digits.
const COMPACT_THRESHOLD = 100_000;
const plainFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 });
const compactFormat = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** Format a single value for display according to the widget's unit. */
export function formatValue(value: number, unit: WidgetUnit = "none"): string {
  if (!Number.isFinite(value)) return "—";
  switch (unit) {
    case "duration_ms":
      return formatDuration(value);
    case "duration_s":
      return formatDuration(value * 1000);
    case "bytes":
      return formatBytes(value);
    case "percent":
      return `${formatNumber(value)}%`;
    default:
      return formatNumber(value);
  }
}

function formatNumber(value: number): string {
  return Math.abs(value) >= COMPACT_THRESHOLD
    ? compactFormat.format(value)
    : plainFormat.format(value);
}

// Trim trailing zeros from a fixed-precision number so "15.0" -> "15".
function trim(value: number, digits: number): string {
  return String(Number(value.toFixed(digits)));
}

function formatDuration(ms: number): string {
  const sign = ms < 0 ? "-" : "";
  const x = Math.abs(ms);
  if (x < 1000) return `${sign}${trim(x, x < 10 ? 1 : 0)}ms`;
  const s = x / 1000;
  if (s < 60) return `${sign}${trim(s, s < 10 ? 2 : 1)}s`;
  const m = s / 60;
  if (m < 60) return `${sign}${trim(m, 1)}min`;
  const h = m / 60;
  if (h < 24) return `${sign}${trim(h, 1)}h`;
  return `${sign}${trim(h / 24, 1)}d`;
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

function formatBytes(bytes: number): string {
  const sign = bytes < 0 ? "-" : "";
  let x = Math.abs(bytes);
  let i = 0;
  while (x >= 1024 && i < BYTE_UNITS.length - 1) {
    x /= 1024;
    i++;
  }
  return `${sign}${trim(x, i === 0 ? 0 : 1)}${BYTE_UNITS[i]}`;
}
