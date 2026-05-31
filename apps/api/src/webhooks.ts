import {
  db,
  enqueueRedelivery,
  enqueueTestDelivery,
  generateWebhookSecret,
  schema,
} from "@superlog/db";
import { and, desc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { resolveActiveOrgContext } from "./org-context.js";

type Vars = { userId: string; orgId: string | null };

// biome-ignore lint/suspicious/noExplicitAny: Hono Variables invariance.
export function mountWebhooks(app: Hono<any>): void {
  async function requireProjectAccess(c: Context<{ Variables: Vars }>, projectId: string) {
    const project = await db.query.projects.findFirst({
      where: eq(schema.projects.id, projectId),
    });
    if (!project) throw new HTTPException(404, { message: "project not found" });
    const ctx = await resolveActiveOrgContext({
      userId: c.var.userId,
      preferredOrgId: c.var.orgId,
    });
    if (project.orgId !== ctx.org.id) throw new HTTPException(403, { message: "forbidden" });
    return project;
  }

  app.get("/api/projects/:projectId/webhooks", async (c) => {
    const projectId = c.req.param("projectId");
    await requireProjectAccess(c, projectId);
    const rows = await db.query.webhookEndpoints.findMany({
      where: eq(schema.webhookEndpoints.projectId, projectId),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });
    return c.json(
      rows.map((r) => ({
        id: r.id,
        url: r.url,
        description: r.description,
        enabledEvents: r.enabledEvents,
        disabledAt: r.disabledAt,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
    );
  });

  app.post("/api/projects/:projectId/webhooks", async (c) => {
    const projectId = c.req.param("projectId");
    await requireProjectAccess(c, projectId);
    const body = (await c.req.json().catch(() => ({}))) as {
      url?: unknown;
      description?: unknown;
    };
    const url = typeof body.url === "string" ? body.url.trim() : "";
    if (!url) throw new HTTPException(400, { message: "url required" });
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new Error("invalid protocol");
      }
    } catch {
      throw new HTTPException(400, { message: "url must be a valid http(s) URL" });
    }
    const description =
      typeof body.description === "string" ? body.description.slice(0, 500) : null;
    const secret = generateWebhookSecret();
    const [row] = await db
      .insert(schema.webhookEndpoints)
      .values({ projectId, url, description, secret })
      .returning();
    if (!row) throw new HTTPException(500, { message: "failed to create endpoint" });
    return c.json({
      id: row.id,
      url: row.url,
      description: row.description,
      enabledEvents: row.enabledEvents,
      disabledAt: row.disabledAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      secret: row.secret,
    });
  });

  app.patch("/api/projects/:projectId/webhooks/:id", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    await requireProjectAccess(c, projectId);
    const body = (await c.req.json().catch(() => ({}))) as {
      url?: unknown;
      description?: unknown;
      disabled?: unknown;
    };
    const patch: Partial<typeof schema.webhookEndpoints.$inferInsert> = { updatedAt: new Date() };
    if (typeof body.url === "string") {
      const url = body.url.trim();
      try {
        new URL(url);
      } catch {
        throw new HTTPException(400, { message: "invalid url" });
      }
      patch.url = url;
    }
    if (typeof body.description === "string") patch.description = body.description.slice(0, 500);
    if (typeof body.disabled === "boolean") patch.disabledAt = body.disabled ? new Date() : null;
    const [row] = await db
      .update(schema.webhookEndpoints)
      .set(patch)
      .where(
        and(eq(schema.webhookEndpoints.id, id), eq(schema.webhookEndpoints.projectId, projectId)),
      )
      .returning();
    if (!row) throw new HTTPException(404, { message: "endpoint not found" });
    return c.json({
      id: row.id,
      url: row.url,
      description: row.description,
      enabledEvents: row.enabledEvents,
      disabledAt: row.disabledAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  });

  app.post("/api/projects/:projectId/webhooks/:id/rotate-secret", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    await requireProjectAccess(c, projectId);
    const secret = generateWebhookSecret();
    const [row] = await db
      .update(schema.webhookEndpoints)
      .set({ secret, updatedAt: new Date() })
      .where(
        and(eq(schema.webhookEndpoints.id, id), eq(schema.webhookEndpoints.projectId, projectId)),
      )
      .returning();
    if (!row) throw new HTTPException(404, { message: "endpoint not found" });
    return c.json({ id: row.id, secret });
  });

  app.delete("/api/projects/:projectId/webhooks/:id", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    await requireProjectAccess(c, projectId);
    await db
      .delete(schema.webhookEndpoints)
      .where(
        and(eq(schema.webhookEndpoints.id, id), eq(schema.webhookEndpoints.projectId, projectId)),
      );
    return c.json({ ok: true });
  });

  app.post("/api/projects/:projectId/webhooks/:id/test", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    await requireProjectAccess(c, projectId);
    const endpoint = await db.query.webhookEndpoints.findFirst({
      where: and(
        eq(schema.webhookEndpoints.id, id),
        eq(schema.webhookEndpoints.projectId, projectId),
      ),
    });
    if (!endpoint) throw new HTTPException(404, { message: "endpoint not found" });
    const delivery = await enqueueTestDelivery(endpoint.id);
    return c.json({ deliveryId: delivery?.id ?? null });
  });

  app.get("/api/projects/:projectId/webhooks/:id/deliveries", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    await requireProjectAccess(c, projectId);
    const endpoint = await db.query.webhookEndpoints.findFirst({
      where: and(
        eq(schema.webhookEndpoints.id, id),
        eq(schema.webhookEndpoints.projectId, projectId),
      ),
    });
    if (!endpoint) throw new HTTPException(404, { message: "endpoint not found" });
    const rows = await db.query.webhookDeliveries.findMany({
      where: eq(schema.webhookDeliveries.endpointId, endpoint.id),
      orderBy: [desc(schema.webhookDeliveries.createdAt)],
      limit: 50,
    });
    return c.json(
      rows.map((d) => ({
        id: d.id,
        eventType: d.eventType,
        status: d.status,
        attemptCount: d.attemptCount,
        nextAttemptAt: d.nextAttemptAt,
        lastAttemptAt: d.lastAttemptAt,
        lastResponseStatus: d.lastResponseStatus,
        lastResponseBody: d.lastResponseBody,
        lastError: d.lastError,
        deliveredAt: d.deliveredAt,
        createdAt: d.createdAt,
      })),
    );
  });

  app.get("/api/projects/:projectId/webhooks/:id/deliveries/:deliveryId", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    const deliveryId = c.req.param("deliveryId");
    await requireProjectAccess(c, projectId);
    const delivery = await db.query.webhookDeliveries.findFirst({
      where: eq(schema.webhookDeliveries.id, deliveryId),
    });
    if (!delivery || delivery.endpointId !== id) {
      throw new HTTPException(404, { message: "delivery not found" });
    }
    return c.json(delivery);
  });

  app.post("/api/projects/:projectId/webhooks/:id/deliveries/:deliveryId/redeliver", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    const deliveryId = c.req.param("deliveryId");
    await requireProjectAccess(c, projectId);
    const original = await db.query.webhookDeliveries.findFirst({
      where: eq(schema.webhookDeliveries.id, deliveryId),
    });
    if (!original || original.endpointId !== id) {
      throw new HTTPException(404, { message: "delivery not found" });
    }
    const fresh = await enqueueRedelivery(deliveryId);
    return c.json({ deliveryId: fresh?.id ?? null });
  });
}
