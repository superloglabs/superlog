import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "./client.js";
import { projectMigrations, slackInstallations } from "./schema.js";

// A project is cut over to its Superlog application workspace once its
// project_migrations row has cut_over_at set. From then on the workspace
// serves the customer: the MCP endpoint forwards the project's requests
// there, and the product stops posting to the project's Slack channel.

type CachedWorkspace = { expiresAt: number; workspaceUrl: string | null };

// Caches the answer for each project, including "not cut over", so a caller
// costs one indexed lookup per project every ttlMs at most. A cutover or
// rollback takes effect within ttlMs.
export function createCutOverLookup(
  load: (projectId: string) => Promise<string | null>,
  { ttlMs = 30_000, maxEntries = 10_000, now = Date.now } = {},
): (projectId: string) => Promise<string | null> {
  const cache = new Map<string, CachedWorkspace>();
  return async (projectId) => {
    const cached = cache.get(projectId);
    if (cached && cached.expiresAt > now()) return cached.workspaceUrl;
    const workspaceUrl = await load(projectId);
    cache.delete(projectId);
    cache.set(projectId, { expiresAt: now() + ttlMs, workspaceUrl });
    if (cache.size > maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return workspaceUrl;
  };
}

export async function loadCutOverWorkspaceUrl(projectId: string): Promise<string | null> {
  const row = await db.query.projectMigrations.findFirst({
    columns: { workspaceUrl: true },
    where: and(eq(projectMigrations.projectId, projectId), isNotNull(projectMigrations.cutOverAt)),
  });
  return row?.workspaceUrl ?? null;
}

// The workspace origin of a cut-over project, or null. Cached per process.
export const cutOverWorkspaceUrl = createCutOverLookup(loadCutOverWorkspaceUrl);

export async function isProjectCutOver(projectId: string): Promise<boolean> {
  return (await cutOverWorkspaceUrl(projectId)) !== null;
}

// An installation belongs to one project for its whole life, so its project
// is remembered; the cut-over answer itself stays on the 30-second cache.
const installationProjects = new Map<string, string>();

// Whether a Slack installation's project is cut over. Every Slack post made
// for a project checks this, so the old product stays out of a channel the
// project's workspace now serves.
export async function isSlackInstallationCutOver(installationId: string): Promise<boolean> {
  let projectId = installationProjects.get(installationId);
  if (!projectId) {
    const row = await db.query.slackInstallations.findFirst({
      columns: { projectId: true },
      where: eq(slackInstallations.id, installationId),
    });
    if (!row) return false;
    projectId = row.projectId;
    if (installationProjects.size >= 10_000) installationProjects.clear();
    installationProjects.set(installationId, projectId);
  }
  return isProjectCutOver(projectId);
}
