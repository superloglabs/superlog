import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "./client.js";
import { projectMigrations } from "./schema.js";

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
