import { appPathFromProjectRoute } from "./project-route.ts";

export type ExploreSource = "logs" | "traces" | "metrics" | "resources";

export function sourceFromExplorePath(pathname: string): ExploreSource | null {
  const appPath = appPathFromProjectRoute(pathname);
  const seg = appPath.replace(/^\/explore\/?/, "").split("/")[0];
  if (seg === "logs" || seg === "traces" || seg === "metrics" || seg === "resources") return seg;
  return null;
}
