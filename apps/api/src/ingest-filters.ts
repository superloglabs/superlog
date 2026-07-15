import { db, schema } from "@superlog/db";
import { eq } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  deriveIngestFilterState,
  disabledPairsFromState,
  ingestFilterKey,
  ingestFilterStateSchema,
} from "./ingest-filters-service.js";
import { requireProjectManagerContext } from "./org-authorization-http.js";
import { resolveActiveOrgContext } from "./org-context.js";

type Vars = { userId: string; orgId: string | null };

export function mountIngestFilters(app: Hono<{ Variables: Vars }>) {
  const requireAccess = async (c: Context<{ Variables: Vars }>, projectId: string) => {
    const project = await db.query.projects.findFirst({
      where: eq(schema.projects.id, projectId),
    });
    if (!project) throw new HTTPException(404, { message: "project not found" });
    const ctx = await resolveActiveOrgContext({
      userId: c.var.userId,
      preferredOrgId: c.var.orgId,
    });
    if (project.orgId !== ctx.org.id) throw new HTTPException(403, { message: "forbidden" });
    return { project, user: ctx.user };
  };

  const requireManagerAccess = async (c: Context<{ Variables: Vars }>, projectId: string) => {
    return requireProjectManagerContext(c, projectId);
  };

  const loadDisabled = async (projectId: string): Promise<Set<string>> => {
    const rows = await db.query.projectIngestFilters.findMany({
      where: eq(schema.projectIngestFilters.projectId, projectId),
      columns: { source: true, signal: true },
    });
    return new Set(rows.map((r) => ingestFilterKey(r.source, r.signal)));
  };

  // Current enabled/disabled state for every (source, signal).
  app.get("/api/projects/:projectId/ingest-filters", async (c) => {
    const projectId = c.req.param("projectId");
    await requireAccess(c, projectId);
    return c.json(deriveIngestFilterState(await loadDisabled(projectId)));
  });

  // Replace the project's filters with the posted desired state. Sparse: we only
  // persist the disabled pairs, so the whole set is rewritten transactionally.
  app.put("/api/projects/:projectId/ingest-filters", async (c) => {
    const projectId = c.req.param("projectId");
    await requireManagerAccess(c, projectId);
    const parsed = ingestFilterStateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new HTTPException(400, { message: "invalid body" });

    const disabled = disabledPairsFromState(parsed.data);
    await db.transaction(async (tx) => {
      await tx
        .delete(schema.projectIngestFilters)
        .where(eq(schema.projectIngestFilters.projectId, projectId));
      if (disabled.length > 0) {
        await tx
          .insert(schema.projectIngestFilters)
          .values(disabled.map(({ source, signal }) => ({ projectId, source, signal })));
      }
    });
    return c.json(deriveIngestFilterState(await loadDisabled(projectId)));
  });
}
