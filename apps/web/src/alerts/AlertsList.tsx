import { Link, useNavigate } from "react-router-dom";
import { useMe } from "../api.ts";
import { RowMenu } from "../design/RowMenu.tsx";
import { Btn, Chip, Tile } from "../design/ui.tsx";
import { useAlerts, useDeleteAlert } from "./api.ts";
import type { Alert } from "./types.ts";

export function AlertsList() {
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
      <section className="flex items-center justify-between">
        <h1 className="text-[20px] font-semibold tracking-tight text-fg">Alerts</h1>
        <Btn onClick={() => navigate("/alerts/new")}>+ new alert</Btn>
      </section>

      <Tile padded={false}>
        {list.isLoading && (
          <div className="px-5 py-8 text-center font-mono text-[11px] text-subtle">loading…</div>
        )}
        {list.data && list.data.length === 0 && (
          <div className="px-5 py-12 text-center">
            <div className="font-mono text-[11px] text-subtle">no alerts yet</div>
            <div className="mt-3">
              <Btn variant="secondary" size="sm" onClick={() => navigate("/alerts/new")}>
                + create your first alert
              </Btn>
            </div>
          </div>
        )}
        {list.data?.map((a) => (
          <div
            key={a.id}
            className="flex items-center gap-4 border-b border-border px-5 py-3 last:border-b-0 hover:bg-surface-2"
          >
            <Link to={`/alerts/${a.id}`} className="flex-1 text-[13px] text-fg hover:underline">
              {a.name}
            </Link>
            <Chip tone={a.enabled ? "accent" : "neutral"}>
              {a.enabled ? "enabled" : "disabled"}
            </Chip>
            <span className="font-mono text-[11px] text-muted">
              {a.source}
              {a.source === "metric" && a.metricName ? ` · ${a.metricName}` : ""}
            </span>
            <span className="font-mono text-[11px] text-muted">
              {a.aggregation} {comparatorOp(a.comparator)} {a.threshold}
            </span>
            <span className="font-mono text-[10px] tabular-nums text-subtle">
              {a.lastEvaluatedAt ? new Date(a.lastEvaluatedAt).toLocaleString() : "never run"}
            </span>
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
          </div>
        ))}
      </Tile>
    </div>
  );
}
