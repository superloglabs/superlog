import { createHmac, timingSafeEqual } from "node:crypto";
import { type DB, db as defaultDb, schema } from "@superlog/db";
import { webhookFetch } from "@superlog/net-guard";
import { and, asc, desc, eq, lte } from "drizzle-orm";
import { logger } from "./logger.js";

// Transport lives here (worker-only). Payload builders + enqueue live in
// @superlog/db so both apps can emit events; re-export the agent-run.completed
// enqueue for existing worker call sites that import it from "../webhooks.js".
export { generateWebhookSecret, enqueueTestDelivery, enqueueRedelivery } from "@superlog/db";
export {
  enqueueAgentRunCompleted,
  buildAgentRunCompletedPayload,
  type AgentRunCompletedPayload,
} from "@superlog/db";

const MAX_ATTEMPTS = 8;
const BATCH = 20;
const REQUEST_TIMEOUT_MS = 10_000;

export function backoffDelayMs(attempt: number): number {
  // 30s, 1m, 2m, 5m, 15m, 1h, 6h, 24h — caller bumps `attempt` before lookup.
  const ladder = [30_000, 60_000, 120_000, 300_000, 900_000, 3_600_000, 21_600_000, 86_400_000];
  const idx = Math.max(0, Math.min(attempt - 1, ladder.length - 1));
  return ladder[idx] as number;
}

export function signPayload(secret: string, timestamp: number, body: string): string {
  const mac = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

export function verifySignature(opts: {
  secret: string;
  header: string;
  body: string;
  toleranceSeconds?: number;
  now?: number;
}): boolean {
  const tolerance = opts.toleranceSeconds ?? 5 * 60;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const parts = Object.fromEntries(
    opts.header.split(",").map((p) => {
      const i = p.indexOf("=");
      return i < 0 ? [p, ""] : [p.slice(0, i), p.slice(i + 1)];
    }),
  );
  const ts = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(ts) || !v1) return false;
  if (Math.abs(now - ts) > tolerance) return false;
  const expected = createHmac("sha256", opts.secret).update(`${ts}.${opts.body}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(v1);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function attemptDelivery(
  endpoint: schema.WebhookEndpoint,
  delivery: schema.WebhookDelivery,
  database: DB,
): Promise<void> {
  const body = JSON.stringify(delivery.payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signPayload(endpoint.secret, timestamp, body);
  const attemptCount = delivery.attemptCount + 1;
  const now = new Date();

  let status: number | null = null;
  let errorMessage: string | null = null;

  try {
    // webhookFetch is SSRF-guarded: it rejects non-public destinations and pins
    // the connection to a validated IP, so a delivery to an internal host fails
    // here with an error instead of proxying the request.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      // Response body is deliberately not read or stored — we only need whether
      // delivery succeeded, and reflecting an internal response back to the
      // tenant would defeat the point of the egress guard.
      const res = await webhookFetch(endpoint.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "Superlog-Webhooks/1.0",
          "superlog-signature": signature,
          "superlog-event": delivery.eventType,
          "superlog-delivery": delivery.id,
        },
        body,
        signal: controller.signal,
      });
      status = res.status;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  const success = status !== null && status >= 200 && status < 300;
  if (success) {
    await database
      .update(schema.webhookDeliveries)
      .set({
        status: "success",
        attemptCount,
        lastAttemptAt: now,
        deliveredAt: now,
        lastResponseStatus: status,
        lastResponseBody: null,
        lastError: null,
      })
      .where(eq(schema.webhookDeliveries.id, delivery.id));
    return;
  }

  const exhausted = attemptCount >= MAX_ATTEMPTS;
  const nextAttemptAt = exhausted ? now : new Date(now.getTime() + backoffDelayMs(attemptCount));
  await database
    .update(schema.webhookDeliveries)
    .set({
      status: exhausted ? "failed" : "pending",
      attemptCount,
      lastAttemptAt: now,
      lastResponseStatus: status,
      lastResponseBody: null,
      lastError: errorMessage,
      nextAttemptAt,
    })
    .where(eq(schema.webhookDeliveries.id, delivery.id));
}

/**
 * Pick up pending deliveries whose nextAttemptAt is due and send them.
 * Returns the number of deliveries attempted in this tick.
 */
export async function tickWebhooks(database: DB = defaultDb): Promise<number> {
  const due = await database
    .select()
    .from(schema.webhookDeliveries)
    .where(
      and(
        eq(schema.webhookDeliveries.status, "pending"),
        lte(schema.webhookDeliveries.nextAttemptAt, new Date()),
      ),
    )
    .orderBy(asc(schema.webhookDeliveries.nextAttemptAt))
    .limit(BATCH);
  if (due.length === 0) return 0;

  const endpointIds = Array.from(new Set(due.map((d) => d.endpointId)));
  const endpoints = await database.query.webhookEndpoints.findMany({
    where: (t, { inArray }) => inArray(t.id, endpointIds),
  });
  const byId = new Map(endpoints.map((e) => [e.id, e]));

  for (const delivery of due) {
    const endpoint = byId.get(delivery.endpointId);
    if (!endpoint) {
      await database
        .update(schema.webhookDeliveries)
        .set({ status: "failed", lastError: "endpoint missing" })
        .where(eq(schema.webhookDeliveries.id, delivery.id));
      continue;
    }
    if (endpoint.disabledAt) {
      await database
        .update(schema.webhookDeliveries)
        .set({ status: "failed", lastError: "endpoint disabled" })
        .where(eq(schema.webhookDeliveries.id, delivery.id));
      continue;
    }
    try {
      await attemptDelivery(endpoint, delivery, database);
    } catch (err) {
      logger.error(
        {
          scope: "webhooks.deliver",
          delivery_id: delivery.id,
          err: err instanceof Error ? err.message : String(err),
        },
        "webhook delivery threw",
      );
    }
  }
  return due.length;
}

// Quiet the unused-import warning for the convenience re-export pattern.
export { desc };
