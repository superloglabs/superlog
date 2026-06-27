import { type ExploreRange, type MetricSeriesRow, useExploreMetricSeries } from "../../api.ts";
import type { Widget } from "../types.ts";
import { defaultChartType, widgetFilterToExplore } from "../types.ts";
import { CountChart } from "./CountChart.tsx";
import { DEFAULT_TOP_N } from "./series-topn.ts";
import { WidgetEmpty, WidgetLoading } from "./shared.tsx";

// Stable ref so CountChart's series memo doesn't recompute every render.
const metricValue = (r: MetricSeriesRow) => r.value;

export function TimeseriesMetricWidget({
  projectId,
  range,
  widget,
}: {
  projectId: string;
  range: ExploreRange;
  widget: Widget;
}) {
  const filter = widgetFilterToExplore(widget.config, range);
  const q = useExploreMetricSeries(
    projectId,
    widget.config.metricName || undefined,
    filter,
    widget.config.groupBy || undefined,
    widget.config.aggregation,
  );

  if (!widget.config.metricName) {
    return (
      <div className="flex h-full min-h-[120px] items-center justify-center font-mono text-[11px] text-subtle">
        no metric selected
      </div>
    );
  }
  if (q.isLoading) return <WidgetLoading />;
  if (!q.data || q.data.rows.length === 0) return <WidgetEmpty />;
  return (
    <div className="h-full min-h-[120px]">
      <CountChart
        rows={q.data.rows}
        value={metricValue}
        range={range}
        step={q.data.step}
        chartType={widget.config.chartType ?? defaultChartType(widget.type)}
        limit={widget.config.limit ?? DEFAULT_TOP_N}
        showXAxis={widget.config.showXAxis ?? true}
        showYAxis={widget.config.showYAxis ?? true}
        showLegend={widget.config.showLegend ?? false}
        legendPosition={widget.config.legendPosition ?? "side"}
        unit={widget.config.unit ?? "none"}
        // The window total of per-bucket aggregates is meaningless for a gauge
        // metric, so the legend headline mirrors the widget's own aggregation
        // (defaulting to avg, which is the server default for gauge metrics).
        legendAgg={widget.config.aggregation ?? "avg"}
      />
    </div>
  );
}
