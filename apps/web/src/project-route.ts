export type ProjectRouteSlugs = {
  orgSlug: string;
  projectSlug: string;
};

export type ProjectRouteLocation = {
  pathname: string;
  search: string;
  hash: string;
};

const PROJECT_ROUTE_PATTERN = "org/:orgSlug/project/:projectSlug";

export function buildProjectPath(slugs: ProjectRouteSlugs, appPath: string): string {
  const root = `/app/org/${encodeURIComponent(slugs.orgSlug)}/project/${encodeURIComponent(slugs.projectSlug)}`;
  if (appPath === "/" || appPath === "") return root;
  const suffix = appPath.startsWith("/") ? appPath : `/${appPath}`;
  return `${root}${suffix}`;
}

export function appPathFromProjectRoute(pathname: string): string {
  const match = /^\/(?:app\/)?org\/[^/]+\/project\/[^/]+(?<appPath>\/.*)?$/.exec(pathname);
  if (match) return match.groups?.appPath || "/";
  if (pathname === "/app" || pathname === "/app/") return "/";
  if (pathname.startsWith("/app/")) return pathname.slice(4);
  return pathname;
}

export function canonicalProjectLocation(
  slugs: ProjectRouteSlugs,
  location: ProjectRouteLocation,
): ProjectRouteLocation {
  return {
    ...location,
    pathname: buildProjectPath(slugs, appPathFromProjectRoute(location.pathname)),
  };
}

export function scopedProjectRoutePattern(appPath: string): string {
  if (appPath === "/" || appPath === "") return PROJECT_ROUTE_PATTERN;
  const suffix = appPath.startsWith("/") ? appPath.slice(1) : appPath;
  return `${PROJECT_ROUTE_PATTERN}/${suffix}`;
}

export function legacyProductLocation(location: ProjectRouteLocation): string {
  const pathname = location.pathname === "/" ? "" : location.pathname;
  return `/app${pathname}${location.search}${location.hash}`;
}
