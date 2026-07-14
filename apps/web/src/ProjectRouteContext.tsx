import { type ReactNode, createContext, useCallback, useContext } from "react";
import { type ProjectRouteSlugs, buildProjectPath } from "./project-route.ts";

const ProjectRouteContext = createContext<ProjectRouteSlugs | null>(null);

export function ProjectRouteProvider({
  children,
  slugs,
}: {
  children: ReactNode;
  slugs: ProjectRouteSlugs;
}) {
  return <ProjectRouteContext.Provider value={slugs}>{children}</ProjectRouteContext.Provider>;
}

export function useProjectPath() {
  const slugs = useContext(ProjectRouteContext);
  return useCallback(
    (appPath: string) => (slugs ? buildProjectPath(slugs, appPath) : appPath),
    [slugs],
  );
}
