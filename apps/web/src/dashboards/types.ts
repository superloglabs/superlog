import type { ExploreFilter, ResourceAttr } from "../api.ts";
import type { MetricAggregation } from "../api.ts";
import { resolveAttrsWithVariables } from "./variables.ts";
import type { WidgetUnit } from "./widgets/widget-format.ts";

export type WidgetType =
  | "timeseries_count"
  | "timeseries_metric"
  | "trace_table"
  | "log_table"
  | "markdown";

export type ChartType = "line" | "bar";

export type WidgetConfig = {
  source?: "logs" | "traces";
  filter: { resourceAttrs?: ResourceAttr[] };
  groupBy?: string;
  metricName?: string;
  aggregation?: MetricAggregation;
  limit?: number;
  chartType?: ChartType;
  /** How values are formatted on the axis, tooltip, and legend. Defaults to "none". */
  unit?: WidgetUnit;
  showXAxis?: boolean;
  showYAxis?: boolean;
  showLegend?: boolean;
  legendPosition?: LegendPosition;
  markdown?: string;
};

export type LegendPosition = "side" | "bottom";

export function defaultChartType(type: WidgetType): ChartType {
  return type === "timeseries_metric" ? "line" : "bar";
}

export type WidgetLayout = { x: number; y: number; w: number; h: number };

// A dashboard-level template variable. Widget filters reference it from a
// resourceAttr value with the token `$name` (or `${name}`); the dashboard
// substitutes the selected option at view time. See ./variables.ts.
export type DashboardVariable = {
  name: string;
  label?: string;
  options: string[];
  defaultValue?: string;
  attributeKey?: string;
};

export type Widget = {
  id: string;
  dashboardId: string;
  type: WidgetType;
  title: string;
  config: WidgetConfig;
  layout: WidgetLayout;
  position: number;
  createdAt: string;
  updatedAt: string;
};

export type DashboardSummary = {
  id: string;
  projectId: string;
  name: string;
  slug: string;
  variables: DashboardVariable[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type DashboardWithWidgets = DashboardSummary & { widgets: Widget[] };

export function widgetFilterToExplore(
  config: WidgetConfig,
  range: { since: string; until: string },
  variableValues: Record<string, string> = {},
): ExploreFilter {
  return {
    range,
    resourceAttrs: resolveAttrsWithVariables(config.filter.resourceAttrs, variableValues),
  };
}

export function defaultLayoutFor(type: WidgetType): WidgetLayout {
  // y=Infinity-ish: RGL compacts vertically so new widgets snap to the bottom.
  if (type === "markdown") {
    return { x: 0, y: 9999, w: 4, h: 5 };
  }
  if (type === "trace_table" || type === "log_table") {
    return { x: 0, y: 9999, w: 12, h: 6 };
  }
  return { x: 0, y: 9999, w: 6, h: 4 };
}
