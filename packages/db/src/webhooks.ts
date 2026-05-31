import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db as defaultDb, type DB } from "./client.js";
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
  const payload = {
    event: "agent_run.completed",
    eventId: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    test: true,
    message: "This is a test webhook delivery from Superlog.",
    project: { id: endpoint.projectId },
  };
  const [row] = await database
    .insert(schema.webhookDeliveries)
    .values({
      endpointId: endpoint.id,
      eventType: "agent_run.completed",
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
