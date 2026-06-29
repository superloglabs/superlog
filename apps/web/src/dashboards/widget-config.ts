import type { MetricAggregation, ResourceAttr } from "../api.ts";
import type { ChartType, LegendPosition, Widget, WidgetConfig, WidgetType } from "./types.ts";
import { DEFAULT_TOP_N } from "./widgets/series-topn.ts";
import type { WidgetUnit } from "./widgets/widget-format.ts";

export type WidgetKind = "chart" | "table" | "note";
export type WidgetDataSource = "metric" | "traces" | "logs";

export const DEFAULT_ROW_LIMIT = 50;
export const DEFAULT_MARKDOWN =
  "# Note\n\nWrite markdown here. Use bullets, **bold**, and `inline code`.";

// Single, flat form state shared by the create + edit widget UIs. Every
// configurable field lives here; `buildWidgetConfig` projects it down to the
// fields that actually apply to the resulting widget type.
export type WidgetFormState = {
  kind: WidgetKind;
  source: WidgetDataSource;
  metricName: string;
  groupBy: string;
  seriesLimit: number; // top-N series for grouped charts
  rowLimit: number; // row limit for tables
  attrs: ResourceAttr[];
  chartType?: ChartType;
  aggregation: MetricAggregation | "auto";
  unit: WidgetUnit;
  showXAxis: boolean;
  showYAxis: boolean;
  showLegend: boolean;
  legendPosition: LegendPosition;
  markdown: string;
};

export function emptyWidgetForm(): WidgetFormState {
  return {
    kind: "chart",
    source: "logs",
    metricName: "",
    groupBy: "",
    seriesLimit: DEFAULT_TOP_N,
    rowLimit: DEFAULT_ROW_LIMIT,
    attrs: [],
    chartType: undefined,
    aggregation: "auto",
    unit: "none",
    showXAxis: true,
    showYAxis: true,
    showLegend: false,
    legendPosition: "side",
    markdown: DEFAULT_MARKDOWN,
  };
}

export function widgetTypeFor(kind: WidgetKind, source: WidgetDataSource): WidgetType {
  if (kind === "note") return "markdown";
  if (kind === "chart") {
    if (source === "metric") return "timeseries_metric";
    return "timeseries_count";
  }
  return source === "traces" ? "trace_table" : "log_table";
}

export function generateTitle({
  kind,
  source,
  metricName,
  groupBy,
  attrs,
  markdown,
}: {
  kind: WidgetKind;
  source: WidgetDataSource;
  metricName: string;
  groupBy: string;
  attrs: ResourceAttr[];
  markdown: string;
}): string {
  if (kind === "note") {
    const firstHeading = markdown
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("# "));
    return firstHeading ? firstHeading.replace(/^#+\s+/, "").slice(0, 80) : "markdown note";
  }
  if (kind === "chart") {
    if (source === "metric") {
      const base = metricName || "metric";
      return groupBy ? `${base} by ${groupBy}` : base;
    }
    if (groupBy) return `${source} by ${groupBy}`;
    return `${source} over time`;
  }
  const base = source === "traces" ? "recent traces" : "recent logs";
  if (attrs.length === 0) return base;
  const first = attrs[0];
  if (!first) return base;
  return `${source} · ${first.key}=${first.value}${attrs.length > 1 ? ` +${attrs.length - 1}` : ""}`;
}

export function formFromWidget(widget: Widget): WidgetFormState {
  const c = widget.config;
  const kind: WidgetKind =
    widget.type === "markdown"
      ? "note"
      : widget.type === "trace_table" || widget.type === "log_table"
        ? "table"
        : "chart";
  const source: WidgetDataSource =
    widget.type === "timeseries_metric"
      ? "metric"
      : widget.type === "trace_table"
        ? "traces"
        : widget.type === "log_table"
          ? "logs"
          : (c.source ?? "logs"); // timeseries_count
  const isChart = kind === "chart";
  const isTable = kind === "table";
  const base = emptyWidgetForm();
  return {
    kind,
    source,
    metricName: c.metricName ?? "",
    groupBy: c.groupBy ?? "",
    seriesLimit: isChart && c.limit !== undefined ? c.limit : base.seriesLimit,
    rowLimit: isTable && c.limit !== undefined ? c.limit : base.rowLimit,
    attrs: c.filter?.resourceAttrs ?? [],
    chartType: c.chartType,
    aggregation: c.aggregation ?? "auto",
    unit: c.unit ?? "none",
    showXAxis: c.showXAxis ?? base.showXAxis,
    showYAxis: c.showYAxis ?? base.showYAxis,
    showLegend: c.showLegend ?? base.showLegend,
    legendPosition: c.legendPosition ?? base.legendPosition,
    markdown: c.markdown ?? DEFAULT_MARKDOWN,
  };
}

export function buildWidgetConfig(form: WidgetFormState): WidgetConfig {
  const type = widgetTypeFor(form.kind, form.source);
  const isChart = form.kind === "chart";
  const isMetric = isChart && form.source === "metric";
  const isTable = form.kind === "table";
  const isNote = form.kind === "note";
  const grouped = isChart && !!form.groupBy;
  const resourceAttrs = form.attrs.length ? form.attrs : undefined;
  // Only emit the fields that apply to this widget type, and drop `undefined`
  // so the persisted config matches what round-trips back from the DB.
  const config: WidgetConfig = { filter: resourceAttrs ? { resourceAttrs } : {} };
  const set = <K extends keyof WidgetConfig>(key: K, value: WidgetConfig[K] | undefined) => {
    if (value !== undefined) config[key] = value;
  };
  if (type === "timeseries_count") set("source", form.source === "traces" ? "traces" : "logs");
  set("groupBy", grouped ? form.groupBy : undefined);
  set("metricName", isMetric ? form.metricName || undefined : undefined);
  set("aggregation", isMetric && form.aggregation !== "auto" ? form.aggregation : undefined);
  set("limit", isTable ? form.rowLimit : grouped ? form.seriesLimit : undefined);
  set("chartType", isChart ? form.chartType : undefined);
  set("unit", isChart && form.unit !== "none" ? form.unit : undefined);
  set("showXAxis", isChart ? form.showXAxis : undefined);
  set("showYAxis", isChart ? form.showYAxis : undefined);
  set("showLegend", isChart ? form.showLegend : undefined);
  set("legendPosition", isChart && form.showLegend ? form.legendPosition : undefined);
  set("markdown", isNote ? form.markdown : undefined);
  return config;
}
