import { type ExploreRange, type SeriesRow, useExploreSeries } from "../../api.ts";
import type { Widget } from "../types.ts";
import { defaultChartType, widgetFilterToExplore } from "../types.ts";
import { CountChart } from "./CountChart.tsx";
import { DEFAULT_TOP_N } from "./series-topn.ts";
import { WidgetEmpty, WidgetLoading } from "./shared.tsx";

// Stable ref so CountChart's series memo doesn't recompute every render.
const countValue = (r: SeriesRow) => r.count;

export function TimeseriesCountWidget({
  projectId,
  range,
  widget,
}: {
  projectId: string;
  range: ExploreRange;
  widget: Widget;
}) {
  const source = widget.config.source === "traces" ? "traces" : "logs";
  const filter = widgetFilterToExplore(widget.config, range);
  const q = useExploreSeries(projectId, source, filter, widget.config.groupBy || undefined);

  if (q.isLoading) return <WidgetLoading />;
  if (!q.data || q.data.rows.length === 0) return <WidgetEmpty />;
  return (
    <div className="h-full min-h-[120px]">
      <CountChart
        rows={q.data.rows}
        value={countValue}
        range={range}
        step={q.data.step}
        chartType={widget.config.chartType ?? defaultChartType(widget.type)}
        limit={widget.config.limit ?? DEFAULT_TOP_N}
        showXAxis={widget.config.showXAxis ?? true}
        showYAxis={widget.config.showYAxis ?? true}
        showLegend={widget.config.showLegend ?? false}
        legendPosition={widget.config.legendPosition ?? "side"}
      />
    </div>
  );
}
