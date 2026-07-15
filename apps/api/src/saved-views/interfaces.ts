import { db, schema } from "@superlog/db";
import { eq } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { resolveActiveOrgContext } from "../org-context.js";
import { createSavedViewApplication } from "./application.js";
import type { SavedView } from "./domain.js";
import { DrizzleSavedViewRepository } from "./repository.js";

type Vars = { userId: string; orgId: string | null };

const attrSchema = z.object({ key: z.string().min(1).max(200), value: z.string().max(500) });
const rangeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("relative"),
    seconds: z.number().int().positive().max(31_536_000),
    label: z.string().min(1).max(80),
  }),
  z.object({
    type: z.literal("absolute"),
    since: z.string().datetime(),
    until: z.string().datetime(),
  }),
]);
const stateSchema = z.object({
  source: z.enum(["logs", "traces"]),
  range: rangeSchema,
  attrs: z.array(attrSchema).max(50),
  severity: z.string().max(80).optional(),
  statusCode: z.string().max(80).optional(),
  groupBy: z.string().max(200).optional(),
  tracesView: z.enum(["traces", "spans"]).optional(),
});
const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  visibility: z.enum(["personal", "workspace"]),
  state: stateSchema,
});
const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    visibility: z.enum(["personal", "workspace"]).optional(),
    state: stateSchema.optional(),
  })
  .refine((input) => Object.keys(input).length > 0);

const application = createSavedViewApplication(new DrizzleSavedViewRepository());

async function requireProjectAccess(c: Context<{ Variables: Vars }>, projectId: string) {
  const project = await db.query.projects.findFirst({
    where: eq(schema.projects.id, projectId),
  });
  if (!project) throw new HTTPException(404, { message: "project not found" });
  const context = await resolveActiveOrgContext({
    userId: c.var.userId,
    preferredOrgId: c.var.orgId,
  });
  if (project.orgId !== context.org.id) {
    throw new HTTPException(403, { message: "forbidden" });
  }
}

function toResponse(view: SavedView, userId: string) {
  return {
    id: view.id,
    name: view.name,
    visibility: view.visibility,
    state: view.state,
    ownedByMe: view.createdByUserId === userId,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  };
}

export function mountSavedViews(app: Hono<{ Variables: Vars }>) {
  app.get("/api/projects/:projectId/saved-views", async (c) => {
    const projectId = c.req.param("projectId");
    await requireProjectAccess(c, projectId);
    const views = await application.list(projectId, c.var.userId);
    return c.json(views.map((view) => toResponse(view, c.var.userId)));
  });

  app.post("/api/projects/:projectId/saved-views", async (c) => {
    const projectId = c.req.param("projectId");
    await requireProjectAccess(c, projectId);
    const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new HTTPException(400, { message: "invalid body" });
    const view = await application.create({
      projectId,
      createdByUserId: c.var.userId,
      ...parsed.data,
    });
    return c.json(toResponse(view, c.var.userId));
  });

  app.patch("/api/projects/:projectId/saved-views/:id", async (c) => {
    const projectId = c.req.param("projectId");
    await requireProjectAccess(c, projectId);
    const parsed = updateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new HTTPException(400, { message: "invalid body" });
    const result = await application.update({
      projectId,
      id: c.req.param("id"),
      userId: c.var.userId,
      input: parsed.data,
    });
    if (result.status === "not_found") {
      throw new HTTPException(404, { message: "saved view not found" });
    }
    if (result.status === "forbidden") {
      throw new HTTPException(403, { message: "forbidden" });
    }
    return c.json(toResponse(result.view, c.var.userId));
  });

  app.delete("/api/projects/:projectId/saved-views/:id", async (c) => {
    const projectId = c.req.param("projectId");
    await requireProjectAccess(c, projectId);
    const result = await application.delete({
      projectId,
      id: c.req.param("id"),
      userId: c.var.userId,
    });
    if (result.status === "not_found") {
      throw new HTTPException(404, { message: "saved view not found" });
    }
    if (result.status === "forbidden") {
      throw new HTTPException(403, { message: "forbidden" });
    }
    return c.json({ ok: true });
  });
}
