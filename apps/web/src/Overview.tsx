import { useNavigate } from "react-router-dom";
import { IncidentRow } from "./Issues.tsx";
import { useCloudConnections, useIncidents, useMe } from "./api.ts";
import { PageHeader } from "./design/ui.tsx";
import { SetupTodos } from "./onboarding/SetupTodos.tsx";
import { ServiceMap } from "./service-map/ServiceMap.tsx";

const ACTIVE_INCIDENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const ACTIVE_INCIDENT_LIMIT = 5;

export function Overview() {
  const me = useMe();

  if (me.isLoading) {
    return <div className="text-[12px] text-muted">Loading…</div>;
  }
  if (me.error) {
    return <div className="text-[12px] text-danger">Error: {String(me.error)}</div>;
  }
  if (!me.data || !me.data.project) return null;
  const projectId = me.data.project.id;

  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        title="Overview"
        description="Project health, recent critical activity, and the connections that shape your system."
      />
      <SetupTodos projectId={projectId} />
      <ActiveIncidentsSection projectId={projectId} />
      <ServiceMapSection projectId={projectId} />
    </div>
  );
}

// Only surface the map for projects that have connected AWS — it's meaningless
// (and noise) without an inventory to draw from.
function ServiceMapSection({ projectId }: { projectId: string }) {
  const connections = useCloudConnections(projectId);
  if (!connections.data || connections.data.length === 0) return null;
  return <ServiceMap projectId={projectId} />;
}

function ActiveIncidentsSection({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const incidents = useIncidents(projectId, "open");

  const cutoff = Date.now() - ACTIVE_INCIDENT_WINDOW_MS;
  const important = (incidents.data ?? [])
    .filter(
      (row) =>
        (row.incident.severity === "SEV-1" || row.incident.severity === "SEV-2") &&
        new Date(row.incident.lastSeen).getTime() >= cutoff,
    )
    .slice(0, ACTIVE_INCIDENT_LIMIT);

  return (
    <section>
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="text-[15px] font-medium text-fg">Active critical incidents</h2>
        {incidents.isFetching && <span className="text-[11px] text-subtle">Refreshing…</span>}
      </div>
      {incidents.isLoading ? (
        <div className="rounded-xl border border-border bg-surface p-6 text-[13px] text-muted">
          Loading…
        </div>
      ) : incidents.error ? (
        <div className="rounded-xl border border-border bg-surface p-6 text-[13px] text-danger">
          Failed to load: {String(incidents.error)}
        </div>
      ) : important.length === 0 ? (
        <div className="rounded-xl border border-border bg-surface p-6 text-center">
          <p className="text-[13px] text-muted">
            All clear — no SEV-1 or SEV-2 incidents in the last 24h
          </p>
        </div>
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
          {important.map((row) => (
            <IncidentRow
              key={row.incident.id}
              row={row}
              selected={false}
              onClick={() => navigate(`/incidents/${row.incident.id}`)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
