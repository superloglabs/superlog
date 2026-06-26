import type { ClickHouseClient } from "@clickhouse/client";
import { db, schema } from "@superlog/db";
import { eq } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  alertInputSchema,
  createAlertRecord,
  deleteAlertRecord,
  getAlertWithFirings,
  listAlertEpisodes,
  listAlertsForProject,
  previewAlert,
  previewAlertSeries,
  testAlertById,
  updateAlertRecord,
} from "./alerts-service.js";
import { resolveActiveOrgContext } from "./org-context.js";

type Vars = { userId: string; orgId: string | null };

export { evaluateAlertQuery } from "./alerts-service.js";

export function mountAlerts(app: Hono<{ Variables: Vars }>, opts: { ch: ClickHouseClient }) {
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

  app.get("/api/projects/:projectId/alerts", async (c) => {
    const projectId = c.req.param("projectId");
    await requireAccess(c, projectId);
    return c.json(await listAlertsForProject(projectId));
  });

  app.post("/api/projects/:projectId/alerts", async (c) => {
    const projectId = c.req.param("projectId");
    const { user } = await requireAccess(c, projectId);
    const body = await c.req.json().catch(() => ({}));
    const parsed = alertInputSchema.safeParse(body);
    if (!parsed.success) throw new HTTPException(400, { message: "invalid body" });
    return c.json(await createAlertRecord(projectId, user.id, parsed.data));
  });

  app.get("/api/projects/:projectId/alerts/:id", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    await requireAccess(c, projectId);
    const alert = await getAlertWithFirings(projectId, id);
    if (!alert) throw new HTTPException(404, { message: "alert not found" });
    return c.json(alert);
  });

  app.get("/api/projects/:projectId/alerts/:id/episodes", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    await requireAccess(c, projectId);
    const episodes = await listAlertEpisodes(projectId, id);
    if (episodes === null) throw new HTTPException(404, { message: "alert not found" });
    return c.json(episodes);
  });

  app.patch("/api/projects/:projectId/alerts/:id", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    await requireAccess(c, projectId);
    const body = await c.req.json().catch(() => ({}));
    const parsed = alertInputSchema.partial().safeParse(body);
    if (!parsed.success) throw new HTTPException(400, { message: "invalid body" });
    const updated = await updateAlertRecord(projectId, id, parsed.data);
    if (!updated) throw new HTTPException(404, { message: "alert not found" });
    return c.json(updated);
  });

  app.delete("/api/projects/:projectId/alerts/:id", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    const { user } = await requireAccess(c, projectId);
    await deleteAlertRecord(projectId, id, user.id);
    return c.json({ ok: true });
  });

  app.post("/api/projects/:projectId/alerts/preview", async (c) => {
    const projectId = c.req.param("projectId");
    await requireAccess(c, projectId);
    const body = await c.req.json().catch(() => ({}));
    const parsed = alertInputSchema.safeParse(body);
    if (!parsed.success) throw new HTTPException(400, { message: "invalid body" });
    return c.json(await previewAlert(opts.ch, projectId, parsed.data));
  });

  app.post("/api/projects/:projectId/alerts/preview-series", async (c) => {
    const projectId = c.req.param("projectId");
    await requireAccess(c, projectId);
    const body = await c.req.json().catch(() => ({}));
    const parsed = alertInputSchema.safeParse(body);
    if (!parsed.success) throw new HTTPException(400, { message: "invalid body" });
    return c.json(await previewAlertSeries(opts.ch, projectId, parsed.data));
  });

  app.post("/api/projects/:projectId/alerts/:id/test", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    await requireAccess(c, projectId);
    const result = await testAlertById(opts.ch, projectId, id);
    if (!result) throw new HTTPException(404, { message: "alert not found" });
    return c.json(result);
  });
}
