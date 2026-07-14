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
  const root = `/org/${encodeURIComponent(slugs.orgSlug)}/project/${encodeURIComponent(slugs.projectSlug)}`;
  if (appPath === "/" || appPath === "") return root;
  const suffix = appPath.startsWith("/") ? appPath : `/${appPath}`;
  return `${root}${suffix}`;
}

export function appPathFromProjectRoute(pathname: string): string {
  const match = /^\/org\/[^/]+\/project\/[^/]+(?<appPath>\/.*)?$/.exec(pathname);
  if (!match) return pathname;
  return match.groups?.appPath || "/";
}

export function canonicalProjectLocation(
  slugs: ProjectRouteSlugs,
  location: ProjectRouteLocation,
): ProjectRouteLocation {
  return {
    ...location,
    pathname: buildProjectPath(slugs, location.pathname),
  };
}

export function appLocationFromProjectRoute(location: ProjectRouteLocation): ProjectRouteLocation {
  return {
    ...location,
    pathname: appPathFromProjectRoute(location.pathname),
  };
}
