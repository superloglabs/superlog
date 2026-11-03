import type { Me } from "./api.ts";

// Where to send a member of a project that moved to its Superlog application
// workspace, or null to stay. Staff impersonating a member stay, so support
// can still read the project here. Only an HTTPS origin is followed.
export function projectMovedTarget(me: Pick<Me, "project" | "user"> | undefined): string | null {
  const workspaceUrl = me?.project?.workspaceUrl;
  if (!workspaceUrl || me.user.impersonating) return null;
  let url: URL;
  try {
    url = new URL(workspaceUrl);
  } catch {
    return null;
  }
  return url.protocol === "https:" ? `${url.origin}/` : null;
}

// Seconds the notice shows before it opens the workspace.
export const projectMovedDelaySeconds = 5;
