import { useNavigate } from "react-router-dom";
import { IncidentRow } from "../Issues.tsx";
import { useCloudConnections, useIncidents } from "../api.ts";
import { type ProjectRouteSlugs, buildProjectPath } from "../project-route.ts";
import { ServiceMap } from "../service-map/ServiceMap.tsx";
import { homeWidgetPresentation } from "./home-layout.ts";

const ACTIVE_INCIDENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const ACTIVE_INCIDENT_LIMIT = 5;

export function ActiveIncidentsHomeWidget({
  projectId,
  slugs,
}: {
  projectId: string;
  slugs: ProjectRouteSlugs;
}) {
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

  if (incidents.isLoading) return <HomeMessage>Loading…</HomeMessage>;
  if (incidents.error) return <HomeMessage tone="danger">Failed to load incidents</HomeMessage>;
  if (important.length === 0) {
    return <HomeMessage>All clear — no SEV-1 or SEV-2 incidents in the last 24h</HomeMessage>;
  }

  const presentation = homeWidgetPresentation("active_incidents");
  return (
    <div
      className={`divide-y divide-border ${
        presentation.innerShell ? "overflow-hidden rounded-lg border border-border" : ""
      }`}
    >
      {important.map((row) => (
        <IncidentRow
          key={row.incident.id}
          row={row}
          selected={false}
          onClick={() => navigate(buildProjectPath(slugs, `/incidents/${row.incident.id}`))}
        />
      ))}
    </div>
  );
}

export function ServiceMapHomeWidget({ projectId }: { projectId: string }) {
  const connections = useCloudConnections(projectId);
  if (connections.isLoading) return <HomeMessage>Loading…</HomeMessage>;
  if (!connections.data || connections.data.length === 0) {
    return <HomeMessage>Connect a cloud account to populate your service map.</HomeMessage>;
  }
  return <ServiceMap projectId={projectId} hideHeader />;
}

function HomeMessage({
  children,
  tone = "muted",
}: {
  children: string;
  tone?: "muted" | "danger";
}) {
  return (
    <div
      className={`grid h-full min-h-28 place-items-center text-center text-[12px] ${
        tone === "danger" ? "text-danger" : "text-muted"
      }`}
    >
      {children}
    </div>
  );
}
