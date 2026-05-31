import type { ExploreRange } from "../../api.ts";
import type { Widget } from "../types.ts";
import { LogTableWidget } from "./LogTableWidget.tsx";
import { MarkdownWidget } from "./MarkdownWidget.tsx";
import { TimeseriesCountWidget } from "./TimeseriesCountWidget.tsx";
import { TimeseriesMetricWidget } from "./TimeseriesMetricWidget.tsx";
import { TraceTableWidget } from "./TraceTableWidget.tsx";

export function WidgetBody({
  projectId,
  range,
  widget,
}: {
  projectId: string;
  range: ExploreRange;
  widget: Widget;
}) {
  switch (widget.type) {
    case "timeseries_count":
      return <TimeseriesCountWidget projectId={projectId} range={range} widget={widget} />;
    case "timeseries_metric":
      return <TimeseriesMetricWidget projectId={projectId} range={range} widget={widget} />;
    case "trace_table":
      return <TraceTableWidget projectId={projectId} range={range} widget={widget} />;
    case "log_table":
      return <LogTableWidget projectId={projectId} range={range} widget={widget} />;
    case "markdown":
      return <MarkdownWidget widget={widget} />;
    default:
      return (
        <div className="font-mono text-[11px] text-danger">unknown widget type: {widget.type}</div>
      );
  }
}
