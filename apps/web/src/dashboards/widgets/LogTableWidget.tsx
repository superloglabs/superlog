import {
  type ExploreRange,
  useExploreLogs,
} from "../../api.ts";
import { LogsTable } from "../../Explore.tsx";
import type { Widget } from "../types.ts";
import { widgetFilterToExplore } from "../types.ts";
import { WidgetLoading } from "./shared.tsx";

export function LogTableWidget({
  projectId,
  range,
  widget,
}: {
  projectId: string;
  range: ExploreRange;
  widget: Widget;
}) {
  const filter = widgetFilterToExplore(widget.config, range);
  const limit = widget.config.limit ?? 50;
  const q = useExploreLogs(projectId, filter, limit);

  if (q.isLoading) return <WidgetLoading />;
  return (
    <div className="h-full overflow-auto">
      <LogsTable rows={(q.data ?? []) as never} />
    </div>
  );
}
