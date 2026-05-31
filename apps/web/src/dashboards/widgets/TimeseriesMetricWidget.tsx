import { MetricLineChart } from "../../Explore.tsx";
import { type ExploreRange, useExploreMetricSeries } from "../../api.ts";
import type { Widget } from "../types.ts";
import { defaultChartType, widgetFilterToExplore } from "../types.ts";
import { WidgetEmpty, WidgetLoading } from "./shared.tsx";

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
      <MetricLineChart
        rows={q.data.rows}
        chartType={widget.config.chartType ?? defaultChartType(widget.type)}
        showXAxis={widget.config.showXAxis ?? false}
        showYAxis={widget.config.showYAxis ?? false}
        showLegend={widget.config.showLegend ?? false}
        height="100%"
      />
    </div>
  );
}
