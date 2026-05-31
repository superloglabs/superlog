import { Link, useNavigate } from "react-router-dom";
import { useMe } from "../api.ts";
import { RowMenu } from "../design/RowMenu.tsx";
import { Btn, Tile } from "../design/ui.tsx";
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
    return (
      <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted">loading…</div>
    );
  }
  if (me.error || !me.data || !me.data.project) {
    return (
      <div className="font-mono text-[11px] text-danger">
        error: {String(me.error ?? "no session")}
      </div>
    );
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
      <section className="flex items-center justify-between">
        <h1 className="text-[20px] font-semibold tracking-tight text-fg">Dashboards</h1>
        <Btn onClick={handleCreate} loading={create.isPending}>
          + new dashboard
        </Btn>
      </section>

      <Tile padded={false}>
        {list.isLoading && (
          <div className="px-5 py-8 text-center font-mono text-[11px] text-subtle">loading…</div>
        )}
        {list.data && list.data.length === 0 && (
          <div className="px-5 py-12 text-center">
            <div className="font-mono text-[11px] text-subtle">no dashboards yet</div>
            <div className="mt-3">
              <Btn variant="secondary" size="sm" onClick={handleCreate} loading={create.isPending}>
                + create your first dashboard
              </Btn>
            </div>
          </div>
        )}
        {list.data?.map((d) => (
          <div
            key={d.id}
            className="flex items-center justify-between border-b border-border px-5 py-3 last:border-b-0 hover:bg-surface-2"
          >
            <Link to={`/dashboards/${d.id}`} className="flex-1 text-[13px] text-fg hover:underline">
              {d.name}
            </Link>
            <span className="mr-4 font-mono text-[10px] tabular-nums text-subtle">
              updated {new Date(d.updatedAt).toLocaleString()}
            </span>
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
          </div>
        ))}
      </Tile>
    </div>
  );
}
