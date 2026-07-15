import {
  WEBHOOK_EVENT_TYPES,
  db,
  enqueueRedelivery,
  enqueueTestDelivery,
  generateWebhookSecret,
  isWebhookEventType,
  schema,
} from "@superlog/db";
import { WebhookDestinationError, assertPublicWebhookUrl } from "@superlog/net-guard";
import { and, desc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireProjectManagerContext } from "./org-authorization-http.js";
import { resolveActiveOrgContext } from "./org-context.js";

type Vars = { userId: string; orgId: string | null };

// Validate a caller-supplied `enabledEvents`. Returns the deduped, known events
// (preserving the canonical order) or throws 400 on an unknown / empty list.
function parseEnabledEvents(raw: unknown): schema.WebhookEventType[] {
  if (!Array.isArray(raw)) {
    throw new HTTPException(400, { message: "enabledEvents must be an array" });
  }
  const requested = new Set<string>();
  for (const value of raw) {
    if (!isWebhookEventType(value)) {
      throw new HTTPException(400, { message: `unknown event type: ${String(value)}` });
    }
    requested.add(value);
  }
  if (requested.size === 0) {
    throw new HTTPException(400, { message: "enabledEvents must include at least one event" });
  }
  return WEBHOOK_EVENT_TYPES.filter((event) => requested.has(event));
}

// Reject a destination that isn't a public http(s) endpoint (SSRF guard). The
// worker re-validates and pins the connection at delivery time; this is the
// fail-fast check so a bad URL is rejected at create/update instead of silently
// failing every delivery.
async function assertWebhookUrl(url: string): Promise<void> {
  try {
    await assertPublicWebhookUrl(url);
  } catch (err) {
    if (err instanceof WebhookDestinationError) {
      throw new HTTPException(400, { message: err.message });
    }
    throw err;
  }
}

// Tenant-facing shape of a delivery record. Excludes lastResponseBody and
// lastError — those hold raw upstream response content and are never returned.
function toDeliveryView(d: schema.WebhookDelivery) {
  return {
    id: d.id,
    eventType: d.eventType,
    status: d.status,
    attemptCount: d.attemptCount,
    nextAttemptAt: d.nextAttemptAt,
    lastAttemptAt: d.lastAttemptAt,
    lastResponseStatus: d.lastResponseStatus,
    deliveredAt: d.deliveredAt,
    createdAt: d.createdAt,
  };
}

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

  async function requireProjectManager(c: Context<{ Variables: Vars }>, projectId: string) {
    return (await requireProjectManagerContext(c, projectId)).project;
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
    await requireProjectManager(c, projectId);
    const body = (await c.req.json().catch(() => ({}))) as {
      url?: unknown;
      description?: unknown;
      enabledEvents?: unknown;
    };
    const url = typeof body.url === "string" ? body.url.trim() : "";
    if (!url) throw new HTTPException(400, { message: "url required" });
    await assertWebhookUrl(url);
    const description =
      typeof body.description === "string" ? body.description.slice(0, 500) : null;
    // Omitting enabledEvents falls back to the column default (so existing
    // clients keep working); an explicit list is validated against the catalog.
    const enabledEvents =
      body.enabledEvents === undefined ? undefined : parseEnabledEvents(body.enabledEvents);
    const secret = generateWebhookSecret();
    const [row] = await db
      .insert(schema.webhookEndpoints)
      .values({ projectId, url, description, secret, ...(enabledEvents ? { enabledEvents } : {}) })
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
    await requireProjectManager(c, projectId);
    const body = (await c.req.json().catch(() => ({}))) as {
      url?: unknown;
      description?: unknown;
      disabled?: unknown;
      enabledEvents?: unknown;
    };
    const patch: Partial<typeof schema.webhookEndpoints.$inferInsert> = { updatedAt: new Date() };
    if (typeof body.url === "string") {
      const url = body.url.trim();
      await assertWebhookUrl(url);
      patch.url = url;
    }
    if (typeof body.description === "string") patch.description = body.description.slice(0, 500);
    if (typeof body.disabled === "boolean") patch.disabledAt = body.disabled ? new Date() : null;
    if (body.enabledEvents !== undefined)
      patch.enabledEvents = parseEnabledEvents(body.enabledEvents);
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
    await requireProjectManager(c, projectId);
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
    await requireProjectManager(c, projectId);
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
    await requireProjectManager(c, projectId);
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
    // Only the delivery outcome is exposed — never the raw upstream response
    // body or connection error, which would turn deliveries into a read side
    // channel for whatever the worker reached.
    return c.json(rows.map(toDeliveryView));
  });

  app.get("/api/projects/:projectId/webhooks/:id/deliveries/:deliveryId", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    const deliveryId = c.req.param("deliveryId");
    await requireProjectAccess(c, projectId);
    // Scope the endpoint to projectId so a caller can't read a delivery under
    // another project's endpoint by guessing its id + deliveryId.
    const endpoint = await db.query.webhookEndpoints.findFirst({
      where: and(
        eq(schema.webhookEndpoints.id, id),
        eq(schema.webhookEndpoints.projectId, projectId),
      ),
    });
    if (!endpoint) throw new HTTPException(404, { message: "endpoint not found" });
    const delivery = await db.query.webhookDeliveries.findFirst({
      where: eq(schema.webhookDeliveries.id, deliveryId),
    });
    if (!delivery || delivery.endpointId !== endpoint.id) {
      throw new HTTPException(404, { message: "delivery not found" });
    }
    return c.json(toDeliveryView(delivery));
  });

  app.post("/api/projects/:projectId/webhooks/:id/deliveries/:deliveryId/redeliver", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    const deliveryId = c.req.param("deliveryId");
    await requireProjectManager(c, projectId);
    // Scope the endpoint to projectId so a caller can't redeliver under another
    // project's endpoint by guessing its id + deliveryId.
    const endpoint = await db.query.webhookEndpoints.findFirst({
      where: and(
        eq(schema.webhookEndpoints.id, id),
        eq(schema.webhookEndpoints.projectId, projectId),
      ),
    });
    if (!endpoint) throw new HTTPException(404, { message: "endpoint not found" });
    const original = await db.query.webhookDeliveries.findFirst({
      where: eq(schema.webhookDeliveries.id, deliveryId),
    });
    if (!original || original.endpointId !== endpoint.id) {
      throw new HTTPException(404, { message: "delivery not found" });
    }
    const fresh = await enqueueRedelivery(deliveryId);
    return c.json({ deliveryId: fresh?.id ?? null });
  });
}
