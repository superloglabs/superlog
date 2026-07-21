export type IncidentWebRoute = {
  orgSlug: string;
  projectSlug: string;
  incidentId: string;
};

export function buildAppWebUrl(webOrigin: string, appPath = "/"): string {
  const origin = webOrigin.replace(/\/$/, "");
  if (appPath === "/" || appPath === "") return `${origin}/app`;
  if (appPath.startsWith("?") || appPath.startsWith("#")) return `${origin}/app${appPath}`;
  return `${origin}/app${appPath.startsWith("/") ? appPath : `/${appPath}`}`;
}

export function buildIncidentWebUrl(webOrigin: string, route: IncidentWebRoute): string {
  return `${buildAppWebUrl(webOrigin)}/org/${encodeURIComponent(route.orgSlug)}/project/${encodeURIComponent(route.projectSlug)}/incidents/${encodeURIComponent(route.incidentId)}`;
}
