import { Link, useNavigate } from "react-router-dom";
import { useMe } from "../api.ts";
import { RowMenu } from "../design/RowMenu.tsx";
import {
  Btn,
  Chip,
  DataList,
  DataListCell,
  DataListHeader,
  DataListHeaderCell,
  DataListRow,
  PageHeader,
} from "../design/ui.tsx";
import { useAlerts, useDeleteAlert } from "./api.ts";
import type { Alert } from "./types.ts";

export function AlertsList() {
  const me = useMe();
  if (me.isLoading) {
    return <div className="text-[12px] text-muted">Loading…</div>;
  }
  if (me.error || !me.data || !me.data.project) {
    return <div className="text-[12px] text-danger">Error: {String(me.error ?? "no session")}</div>;
  }
  return <AlertsListInner projectId={me.data.project.id} />;
}

function comparatorOp(c: Alert["comparator"]) {
  return c === "gt" ? ">" : "<";
}

function AlertsListInner({ projectId }: { projectId: string }) {
  const list = useAlerts(projectId);
  const remove = useDeleteAlert(projectId);
  const navigate = useNavigate();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Alerts"
        description="Turn important telemetry thresholds into focused, actionable notifications."
        actions={<Btn onClick={() => navigate("/alerts/new")}>New alert</Btn>}
      />

      <DataList label="Alert rules">
        <DataListHeader className="grid grid-cols-[minmax(0,1fr)_auto_28px] items-center gap-4 sm:grid-cols-[minmax(0,1.4fr)_auto_minmax(100px,.7fr)_28px] lg:grid-cols-[minmax(0,1.4fr)_auto_minmax(100px,.7fr)_minmax(150px,1fr)_minmax(130px,.9fr)_28px]">
          <DataListHeaderCell>Name</DataListHeaderCell>
          <DataListHeaderCell>Status</DataListHeaderCell>
          <DataListHeaderCell className="hidden sm:block">Source</DataListHeaderCell>
          <DataListHeaderCell className="hidden lg:block">Condition</DataListHeaderCell>
          <DataListHeaderCell className="hidden lg:block">Last evaluated</DataListHeaderCell>
          <DataListHeaderCell ariaLabel="Actions" />
        </DataListHeader>
        {list.isLoading && (
          <div className="px-5 py-8 text-center text-[12px] text-subtle">Loading…</div>
        )}
        {list.data && list.data.length === 0 && (
          <div className="px-5 py-12 text-center">
            <div className="text-[12px] text-subtle">No alerts yet</div>
            <div className="mt-3">
              <Btn variant="secondary" size="sm" onClick={() => navigate("/alerts/new")}>
                Create your first alert
              </Btn>
            </div>
          </div>
        )}
        {list.data?.map((a) => (
          <DataListRow
            key={a.id}
            className="grid grid-cols-[minmax(0,1fr)_auto_28px] items-center gap-4 sm:grid-cols-[minmax(0,1.4fr)_auto_minmax(100px,.7fr)_28px] lg:grid-cols-[minmax(0,1.4fr)_auto_minmax(100px,.7fr)_minmax(150px,1fr)_minmax(130px,.9fr)_28px]"
          >
            <DataListCell className="min-w-0">
              <Link
                to={`/alerts/${a.id}`}
                className="block truncate text-[13px] font-medium text-fg hover:underline"
              >
                {a.name}
              </Link>
            </DataListCell>
            <DataListCell>
              <Chip tone={a.enabled ? "accent" : "neutral"}>
                {a.enabled ? "enabled" : "disabled"}
              </Chip>
            </DataListCell>
            <DataListCell className="hidden truncate text-[11px] text-muted sm:block">
              {a.source}
              {a.source === "metric" && a.metricName ? ` · ${a.metricName}` : ""}
            </DataListCell>
            <DataListCell className="hidden truncate text-[11px] text-muted lg:block">
              {a.aggregation} {comparatorOp(a.comparator)} {a.threshold}
            </DataListCell>
            <DataListCell className="hidden truncate text-[10px] tabular-nums text-subtle lg:block">
              {a.lastEvaluatedAt ? new Date(a.lastEvaluatedAt).toLocaleString() : "never run"}
            </DataListCell>
            <DataListCell>
              <RowMenu
                items={[
                  {
                    label: "Delete",
                    danger: true,
                    onClick: () => {
                      if (confirm(`delete "${a.name}"?`)) remove.mutate(a.id);
                    },
                  },
                ]}
              />
            </DataListCell>
          </DataListRow>
        ))}
      </DataList>
    </div>
  );
}
