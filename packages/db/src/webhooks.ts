import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { type DB, db as defaultDb } from "./client.js";
import * as schema from "./schema.js";

/**
 * Generate a fresh signing secret. Stripe-style: customers compute
 * `HMAC-SHA256(secret, "<timestamp>.<rawBody>")` and compare against `v1`.
 */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString("base64url")}`;
}

export async function enqueueTestDelivery(
  endpointId: string,
  database: DB = defaultDb,
): Promise<schema.WebhookDelivery | null> {
  const endpoint = await database.query.webhookEndpoints.findFirst({
    where: eq(schema.webhookEndpoints.id, endpointId),
  });
  if (!endpoint) return null;
  // Stamp the test with whatever event the endpoint subscribes to first, so the
  // Superlog-Event header looks realistic. Falls back to incident.created. The
  // body is a stub — transport + signature only. `message` mirrors the
  // { title, body } render-ready block real events carry.
  const eventType: schema.WebhookEventType = endpoint.enabledEvents?.[0] ?? "incident.created";
  const payload = {
    event: eventType,
    eventId: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    test: true,
    message: {
      title: "Test webhook",
      body: "This is a test webhook delivery from Superlog.",
    },
    project: { id: endpoint.projectId },
  };
  const [row] = await database
    .insert(schema.webhookDeliveries)
    .values({
      endpointId: endpoint.id,
      eventType,
      payload: payload as Record<string, unknown>,
    })
    .returning();
  return row ?? null;
}

export async function enqueueRedelivery(
  deliveryId: string,
  database: DB = defaultDb,
): Promise<schema.WebhookDelivery | null> {
  const original = await database.query.webhookDeliveries.findFirst({
    where: eq(schema.webhookDeliveries.id, deliveryId),
  });
  if (!original) return null;
  const [row] = await database
    .insert(schema.webhookDeliveries)
    .values({
      endpointId: original.endpointId,
      eventType: original.eventType,
      payload: original.payload,
    })
    .returning();
  return row ?? null;
}
