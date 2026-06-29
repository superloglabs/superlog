import type { ExploreRange } from "../api.ts";
import { WidgetForm } from "./WidgetForm.tsx";
import { useCreateWidget } from "./api.ts";
import { type DashboardVariable, defaultLayoutFor } from "./types.ts";
import { emptyWidgetForm } from "./widget-config.ts";

export function AddWidget({
  projectId,
  dashboardId,
  range,
  variables = [],
  onClose,
}: {
  projectId: string;
  dashboardId: string;
  range: ExploreRange;
  variables?: DashboardVariable[];
  onClose: () => void;
}) {
  const create = useCreateWidget(projectId, dashboardId);

  return (
    <WidgetForm
      projectId={projectId}
      range={range}
      mode="create"
      initial={emptyWidgetForm()}
      variables={variables}
      submitting={create.isPending}
      onClose={onClose}
      onSubmit={async ({ type, config, title }) => {
        await create.mutateAsync({ type, title, config, layout: defaultLayoutFor(type) });
        onClose();
      }}
    />
  );
}
