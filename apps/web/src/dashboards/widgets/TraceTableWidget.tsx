import { TracesTable } from "../../Explore.tsx";
import { type ExploreRange, useExploreTraces } from "../../api.ts";
import type { Widget } from "../types.ts";
import { widgetFilterToExplore } from "../types.ts";
import { useVariableValues } from "../variables-context.tsx";
import { WidgetLoading } from "./shared.tsx";

export function TraceTableWidget({
  projectId,
  range,
  widget,
}: {
  projectId: string;
  range: ExploreRange;
  widget: Widget;
}) {
  const filter = widgetFilterToExplore(widget.config, range, useVariableValues());
  const limit = widget.config.limit ?? 50;
  const q = useExploreTraces(projectId, filter, limit);

  if (q.isLoading) return <WidgetLoading />;
  return (
    <div className="h-full overflow-auto">
      <TracesTable rows={(q.data ?? []) as never} />
    </div>
  );
}
