import { Link, useNavigate } from "react-router-dom";
import { useMe } from "../api.ts";
import { RowMenu } from "../design/RowMenu.tsx";
import {
  Btn,
  DataList,
  DataListCell,
  DataListHeader,
  DataListHeaderCell,
  DataListRow,
  PageHeader,
} from "../design/ui.tsx";
import { useCreateDashboard, useDashboards, useDeleteDashboard } from "./api.ts";

const RANDOM_NAMES = [
  "untitled dashboard",
  "scratch dashboard",
  "new dashboard",
  "fresh dashboard",
];

function randomName() {
  return RANDOM_NAMES[Math.floor(Math.random() * RANDOM_NAMES.length)]!;
}

export function DashboardsList() {
  const me = useMe();
  if (me.isLoading) {
    return <div className="text-[12px] text-muted">Loading…</div>;
  }
  if (me.error || !me.data || !me.data.project) {
    return <div className="text-[12px] text-danger">Error: {String(me.error ?? "no session")}</div>;
  }
  return <DashboardsListInner projectId={me.data.project.id} />;
}

function DashboardsListInner({ projectId }: { projectId: string }) {
  const list = useDashboards(projectId);
  const create = useCreateDashboard(projectId);
  const remove = useDeleteDashboard(projectId);
  const navigate = useNavigate();

  const handleCreate = async () => {
    const dashboard = await create.mutateAsync(randomName());
    navigate(`/dashboards/${dashboard.id}`);
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Dashboards"
        description="Compose durable views of the signals your team returns to every day."
        actions={
          <Btn onClick={handleCreate} loading={create.isPending}>
            New dashboard
          </Btn>
        }
      />

      <DataList label="Dashboards">
        <DataListHeader className="grid grid-cols-[minmax(0,1fr)_auto_28px] items-center gap-4">
          <DataListHeaderCell>Name</DataListHeaderCell>
          <DataListHeaderCell>Last updated</DataListHeaderCell>
          <DataListHeaderCell ariaLabel="Actions" />
        </DataListHeader>
        {list.isLoading && (
          <div className="px-5 py-8 text-center text-[12px] text-subtle">Loading…</div>
        )}
        {list.data && list.data.length === 0 && (
          <div className="px-5 py-12 text-center">
            <div className="text-[12px] text-subtle">No dashboards yet</div>
            <div className="mt-3">
              <Btn variant="secondary" size="sm" onClick={handleCreate} loading={create.isPending}>
                Create your first dashboard
              </Btn>
            </div>
          </div>
        )}
        {list.data?.map((d) => (
          <DataListRow
            key={d.id}
            className="grid grid-cols-[minmax(0,1fr)_auto_28px] items-center gap-4"
          >
            <DataListCell className="min-w-0">
              <Link
                to={`/dashboards/${d.id}`}
                className="block truncate text-[13px] font-medium text-fg hover:underline"
              >
                {d.name}
              </Link>
            </DataListCell>
            <DataListCell className="text-[10px] tabular-nums text-subtle">
              updated {new Date(d.updatedAt).toLocaleString()}
            </DataListCell>
            <DataListCell>
              <RowMenu
                items={[
                  {
                    label: "Delete",
                    danger: true,
                    onClick: () => {
                      if (confirm(`delete "${d.name}"?`)) remove.mutate(d.id);
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
