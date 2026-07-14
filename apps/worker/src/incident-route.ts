export type IncidentRoute = {
  orgSlug: string;
  projectSlug: string;
  incidentId: string;
};

export function buildIncidentUrl(webOrigin: string, route: IncidentRoute): string {
  const origin = webOrigin.replace(/\/$/, "");
  return `${origin}/org/${encodeURIComponent(route.orgSlug)}/project/${encodeURIComponent(route.projectSlug)}/incidents/${encodeURIComponent(route.incidentId)}`;
}

export function buildContextIncidentUrl(
  webOrigin: string,
  context: {
    org: { slug: string };
    project: { slug: string };
    incident: { id: string };
  },
): string {
  return buildIncidentUrl(webOrigin, {
    orgSlug: context.org.slug,
    projectSlug: context.project.slug,
    incidentId: context.incident.id,
  });
}
