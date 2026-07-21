export type IncidentRoute = {
  orgSlug: string;
  projectSlug: string;
  incidentId: string;
};

export function buildAppUrl(webOrigin: string, appPath = ""): string {
  const origin = webOrigin.replace(/\/$/, "");
  if (appPath === "") return `${origin}/app`;
  if (appPath.startsWith("?") || appPath.startsWith("#")) return `${origin}/app${appPath}`;
  return `${origin}/app${appPath.startsWith("/") ? appPath : `/${appPath}`}`;
}

export function buildIncidentUrl(webOrigin: string, route: IncidentRoute): string {
  return buildAppUrl(
    webOrigin,
    `/org/${encodeURIComponent(route.orgSlug)}/project/${encodeURIComponent(route.projectSlug)}/incidents/${encodeURIComponent(route.incidentId)}`,
  );
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
