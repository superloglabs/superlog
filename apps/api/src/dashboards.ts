import { db, schema } from "@superlog/db";
import { eq } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  addDashboardWidget,
  addHomeDataWidget,
  addHomeLink,
  createDashboard,
  dashboardCreateSchema,
  dashboardUpdateSchema,
  dashboardWidgetCreateSchema,
  dashboardWidgetLayoutSchema,
  dashboardWidgetUpdateSchema,
  deleteHomeItem,
  deleteDashboard,
  deleteDashboardWidget,
  getDashboardWithWidgets,
  getOrCreateHomeDashboard,
  homeBuiltinTypeSchema,
  homeDataWidgetCreateSchema,
  homeLinkCreateSchema,
  listDashboardsForProject,
  updateDashboard,
  updateDashboardLayout,
  updateDashboardWidget,
  updateHomeLayout,
  setHomeBuiltin,
} from "./dashboards-service.js";
import { resolveEffectiveReadProjectId } from "./demo.js";
import { resolveActiveOrgContext } from "./org-context.js";

type Vars = { userId: string; orgId: string | null; demoReadProjectId?: string };

export function mountDashboards(app: Hono<{ Variables: Vars }>) {
  // Authorizes against the real project and also returns `readProjectId` — the
  // demo project's id when the real project hasn't ingested yet (read-only
  // overlay), else the real id. GET handlers read from `readProjectId`; writes
  // keep using the real `projectId` (and are blocked in demo mode by the
  // demoReadOnly middleware in index.ts).
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
    const readProjectId =
      c.var.demoReadProjectId ?? (await resolveEffectiveReadProjectId(projectId)).id;
    return { project, user: ctx.user, readProjectId };
  };

  app.get("/api/projects/:projectId/dashboards", async (c) => {
    const projectId = c.req.param("projectId");
    const { readProjectId } = await requireAccess(c, projectId);
    return c.json(await listDashboardsForProject(readProjectId));
  });

  app.get("/api/projects/:projectId/home", async (c) => {
    const projectId = c.req.param("projectId");
    const { user } = await requireAccess(c, projectId);
    return c.json(await getOrCreateHomeDashboard(projectId, user.id));
  });

  app.put("/api/projects/:projectId/home/builtins/:type", async (c) => {
    const projectId = c.req.param("projectId");
    const { user } = await requireAccess(c, projectId);
    const type = homeBuiltinTypeSchema.safeParse(c.req.param("type"));
    const body = await c.req.json().catch(() => ({}));
    const parsed = z.object({ enabled: z.boolean() }).safeParse(body);
    if (!type.success || !parsed.success) {
      throw new HTTPException(400, { message: "invalid home built-in update" });
    }
    return c.json(await setHomeBuiltin(projectId, user.id, type.data, parsed.data.enabled));
  });

  app.post("/api/projects/:projectId/home/widgets", async (c) => {
    const projectId = c.req.param("projectId");
    const { user } = await requireAccess(c, projectId);
    const body = await c.req.json().catch(() => ({}));
    const parsed = homeDataWidgetCreateSchema.safeParse(body);
    if (!parsed.success) throw new HTTPException(400, { message: "invalid home widget" });
    return c.json(await addHomeDataWidget(projectId, user.id, parsed.data));
  });

  app.post("/api/projects/:projectId/home/links", async (c) => {
    const projectId = c.req.param("projectId");
    const { user } = await requireAccess(c, projectId);
    const body = await c.req.json().catch(() => ({}));
    const parsed = homeLinkCreateSchema.safeParse(body);
    if (!parsed.success) throw new HTTPException(400, { message: "invalid home link" });
    return c.json(await addHomeLink(projectId, user.id, parsed.data));
  });

  app.patch("/api/projects/:projectId/home/layout", async (c) => {
    const projectId = c.req.param("projectId");
    const { user } = await requireAccess(c, projectId);
    const body = await c.req.json().catch(() => ({}));
    const parsed = z
      .object({
        widgets: z.array(z.object({ id: z.string().uuid(), layout: dashboardWidgetLayoutSchema })),
      })
      .safeParse(body);
    if (!parsed.success) throw new HTTPException(400, { message: "invalid home layout" });
    await updateHomeLayout(projectId, user.id, parsed.data.widgets);
    return c.json({ ok: true });
  });

  app.delete("/api/projects/:projectId/home/items/:itemId", async (c) => {
    const projectId = c.req.param("projectId");
    const { user } = await requireAccess(c, projectId);
    const deleted = await deleteHomeItem(projectId, user.id, c.req.param("itemId"));
    if (!deleted) throw new HTTPException(404, { message: "home item not found" });
    return c.json({ ok: true });
  });

  app.post("/api/projects/:projectId/dashboards", async (c) => {
    const projectId = c.req.param("projectId");
    const { user } = await requireAccess(c, projectId);
    const body = await c.req.json().catch(() => ({}));
    const parsed = dashboardCreateSchema.safeParse(body);
    if (!parsed.success) throw new HTTPException(400, { message: "invalid body" });
    return c.json(await createDashboard(projectId, user.id, parsed.data));
  });

  app.get("/api/projects/:projectId/dashboards/:id", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    const { readProjectId } = await requireAccess(c, projectId);
    const dashboard = await getDashboardWithWidgets(readProjectId, id);
    if (!dashboard) throw new HTTPException(404, { message: "dashboard not found" });
    return c.json(dashboard);
  });

  app.patch("/api/projects/:projectId/dashboards/:id", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    await requireAccess(c, projectId);
    const body = await c.req.json().catch(() => ({}));
    const parsed = dashboardUpdateSchema.safeParse(body);
    if (!parsed.success) throw new HTTPException(400, { message: "invalid body" });
    const updated = await updateDashboard(projectId, id, parsed.data);
    if (!updated) throw new HTTPException(404, { message: "dashboard not found" });
    return c.json(updated);
  });

  app.delete("/api/projects/:projectId/dashboards/:id", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    await requireAccess(c, projectId);
    await deleteDashboard(projectId, id);
    return c.json({ ok: true });
  });

  app.post("/api/projects/:projectId/dashboards/:id/widgets", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    await requireAccess(c, projectId);
    const body = await c.req.json().catch(() => ({}));
    const parsed = dashboardWidgetCreateSchema.safeParse(body);
    if (!parsed.success) throw new HTTPException(400, { message: "invalid body" });
    const widget = await addDashboardWidget(projectId, id, parsed.data);
    if (!widget) throw new HTTPException(404, { message: "dashboard not found" });
    return c.json(widget);
  });

  app.patch("/api/projects/:projectId/dashboards/:id/widgets/:widgetId", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    const widgetId = c.req.param("widgetId");
    await requireAccess(c, projectId);
    const body = await c.req.json().catch(() => ({}));
    const parsed = dashboardWidgetUpdateSchema.safeParse(body);
    if (!parsed.success) throw new HTTPException(400, { message: "invalid body" });
    const widget = await updateDashboardWidget(projectId, id, widgetId, parsed.data);
    if (!widget) throw new HTTPException(404, { message: "widget not found" });
    return c.json(widget);
  });

  app.patch("/api/projects/:projectId/dashboards/:id/layout", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    await requireAccess(c, projectId);
    const body = await c.req.json().catch(() => ({}));
    const parsed = z
      .object({
        widgets: z
          .array(z.object({ id: z.string().uuid(), layout: dashboardWidgetLayoutSchema }))
          .max(200),
      })
      .safeParse(body);
    if (!parsed.success) throw new HTTPException(400, { message: "invalid body" });
    const ok = await updateDashboardLayout(projectId, id, parsed.data.widgets);
    if (!ok) throw new HTTPException(404, { message: "dashboard not found" });
    return c.json({ ok: true });
  });

  app.delete("/api/projects/:projectId/dashboards/:id/widgets/:widgetId", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    const widgetId = c.req.param("widgetId");
    await requireAccess(c, projectId);
    const ok = await deleteDashboardWidget(projectId, id, widgetId);
    if (!ok) throw new HTTPException(404, { message: "dashboard not found" });
    return c.json({ ok: true });
  });
}
