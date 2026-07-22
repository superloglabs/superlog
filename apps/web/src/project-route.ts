export type ProjectRouteSlugs = {
  orgSlug: string;
  projectSlug: string;
};

export type ProjectRouteLocation = {
  pathname: string;
  search: string;
  hash: string;
};

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

export function appLocationFromProjectRoute(location: ProjectRouteLocation): ProjectRouteLocation {
  const appPath = appPathFromProjectRoute(location.pathname);
  return {
    ...location,
    // This location is consumed by a descendant <Routes> below the top-level
    // /app/* route. React Router requires an overridden location to retain the
    // already-matched parent pathname base; only the project scope is virtual.
    pathname: appPath === "/" ? "/app" : `/app${appPath}`,
  };
}

export function legacyProductLocation(location: ProjectRouteLocation): string {
  const pathname = location.pathname === "/" ? "" : location.pathname;
  return `/app${pathname}${location.search}${location.hash}`;
}
