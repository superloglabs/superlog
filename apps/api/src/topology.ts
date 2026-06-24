import { db, schema } from "@superlog/db";
import { eq } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { resolveEffectiveReadProjectId } from "./demo.js";
import { resolveActiveOrgContext } from "./org-context.js";

type Vars = { userId: string; orgId: string | null; demoReadProjectId?: string };

// Serves the project's persisted service map and lets the UI request a (re)build.
// The actual build+enrich runs in the worker's `build-topologies` job; the API
// only reads the row and flips `refreshRequestedAt`, so they stay decoupled.
export function mountTopology(app: Hono<{ Variables: Vars }>) {
  const requireAccess = async (c: Context<{ Variables: Vars }>, projectId: string) => {
    const project = await db.query.projects.findFirst({ where: eq(schema.projects.id, projectId) });
    if (!project) throw new HTTPException(404, { message: "project not found" });
    const ctx = await resolveActiveOrgContext({
      userId: c.var.userId,
      preferredOrgId: c.var.orgId,
    });
    if (project.orgId !== ctx.org.id) throw new HTTPException(403, { message: "forbidden" });
    const readProjectId =
      c.var.demoReadProjectId ?? (await resolveEffectiveReadProjectId(projectId)).id;
    return { project, readProjectId };
  };

  app.get("/api/projects/:projectId/topology", async (c) => {
    const projectId = c.req.param("projectId");
    const { readProjectId } = await requireAccess(c, projectId);
    const row = await db.query.projectTopologies.findFirst({
      where: eq(schema.projectTopologies.projectId, readProjectId),
    });
    if (!row)
      return c.json({ status: "empty" as const, graph: null, enrichment: null, generatedAt: null });
    return c.json({
      status: row.status,
      graph: row.graph,
      enrichment: row.enrichment,
      generatedAt: row.generatedAt,
      error: row.error,
    });
  });

  // Request a (re)build. Idempotent: upserts the row and marks it pending so the
  // worker job picks it up on its next pass. Uses the real projectId (writes are
  // blocked in demo mode by the demoReadOnly middleware).
  app.post("/api/projects/:projectId/topology/generate", async (c) => {
    const projectId = c.req.param("projectId");
    await requireAccess(c, projectId);
    const now = new Date();
    await db
      .insert(schema.projectTopologies)
      .values({ projectId, status: "generating", refreshRequestedAt: now })
      .onConflictDoUpdate({
        target: schema.projectTopologies.projectId,
        set: { status: "generating", refreshRequestedAt: now, updatedAt: now },
      });
    return c.json({ status: "generating" as const });
  });
}
