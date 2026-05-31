import { createHmac, timingSafeEqual } from "node:crypto";
import { schema, db as defaultDb, type DB } from "@superlog/db";
import { and, asc, desc, eq, isNull, lte } from "drizzle-orm";
import { logger } from "./logger.js";

export { generateWebhookSecret, enqueueTestDelivery, enqueueRedelivery } from "@superlog/db";

const MAX_ATTEMPTS = 8;
const BATCH = 20;
const REQUEST_TIMEOUT_MS = 10_000;
const RESPONSE_BODY_TRUNC = 2048;

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

export type AgentRunCompletedPayload = {
  event: "agent_run.completed";
  eventId: string;
  occurredAt: string;
  project: { id: string; name: string; slug: string };
  agentRun: {
    id: string;
    state: string;
    runtime: string;
    completedAt: string | null;
    startedAt: string | null;
    cumulativeRuntimeMinutes: number;
    resumeCount: number;
    failureReason: string | null;
    result: unknown;
  };
  incident: {
    id: string;
    title: string;
    codename: string;
    status: string;
    severity: string | null;
    service: string | null;
    firstSeen: string;
    lastSeen: string;
    issueCount: number;
    rootCauseText: string | null;
    rootCauseConfidence: number | null;
    estimatedImpactText: string | null;
    estimatedImpactConfidence: number | null;
    suggestedSeverity: string | null;
    noiseClassification: unknown;
    resolutionClassification: unknown;
    findingsAgentRunId: string | null;
  };
  events: Array<{
    id: string;
    kind: string;
    summary: string | null;
    detail: Record<string, unknown> | null;
    createdAt: string;
  }>;
  pullRequests: Array<{
    id: string;
    repoFullName: string;
    prNumber: number;
    url: string;
    branchName: string;
    baseBranch: string;
    state: string;
    title: string | null;
    mergedAt: string | null;
    closedAt: string | null;
  }>;
  linearTickets: Array<{
    id: string;
    workspaceId: string;
    ticketId: string;
    ticketIdentifier: string | null;
    url: string | null;
    title: string | null;
    state: string | null;
  }>;
};

export async function buildAgentRunCompletedPayload(
  database: DB,
  agentRunId: string,
): Promise<{ projectId: string; payload: AgentRunCompletedPayload } | null> {
  const agentRun = await database.query.agentRuns.findFirst({
    where: eq(schema.agentRuns.id, agentRunId),
  });
  if (!agentRun) return null;
  const incident = await database.query.incidents.findFirst({
    where: eq(schema.incidents.id, agentRun.incidentId),
  });
  if (!incident) return null;
  const project = await database.query.projects.findFirst({
    where: eq(schema.projects.id, incident.projectId),
  });
  if (!project) return null;

  const [eventRows, prRows, ticketRows] = await Promise.all([
    database.query.incidentEvents.findMany({
      where: eq(schema.incidentEvents.agentRunId, agentRunId),
      orderBy: (t, { asc }) => [asc(t.createdAt)],
    }),
    database.query.agentPullRequests.findMany({
      where: eq(schema.agentPullRequests.agentRunId, agentRunId),
    }),
    database.query.agentLinearTickets.findMany({
      where: eq(schema.agentLinearTickets.agentRunId, agentRunId),
    }),
  ]);

  const payload: AgentRunCompletedPayload = {
    event: "agent_run.completed",
    eventId: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    project: { id: project.id, name: project.name, slug: project.slug },
    agentRun: {
      id: agentRun.id,
      state: agentRun.state,
      runtime: agentRun.runtime,
      completedAt: agentRun.completedAt?.toISOString() ?? null,
      startedAt: agentRun.startedAt?.toISOString() ?? null,
      cumulativeRuntimeMinutes: agentRun.cumulativeRuntimeMinutes,
      resumeCount: agentRun.resumeCount,
      failureReason: agentRun.failureReason,
      result: agentRun.result ?? null,
    },
    incident: {
      id: incident.id,
      title: incident.title,
      codename: incident.codename,
      status: incident.status,
      severity: incident.severity ?? null,
      service: incident.service ?? null,
      firstSeen: incident.firstSeen.toISOString(),
      lastSeen: incident.lastSeen.toISOString(),
      issueCount: incident.issueCount,
      rootCauseText: incident.rootCauseText,
      rootCauseConfidence: incident.rootCauseConfidence,
      estimatedImpactText: incident.estimatedImpactText,
      estimatedImpactConfidence: incident.estimatedImpactConfidence,
      suggestedSeverity: incident.suggestedSeverity ?? null,
      noiseClassification: incident.noiseClassification,
      resolutionClassification: incident.resolutionClassification,
      findingsAgentRunId: incident.findingsAgentRunId,
    },
    events: eventRows.map((e) => ({
      id: e.id,
      kind: e.kind,
      summary: e.summary,
      detail: e.detail ?? null,
      createdAt: e.createdAt.toISOString(),
    })),
    pullRequests: prRows.map((p) => ({
      id: p.id,
      repoFullName: p.repoFullName,
      prNumber: p.prNumber,
      url: p.url,
      branchName: p.branchName,
      baseBranch: p.baseBranch,
      state: p.state,
      title: p.title,
      mergedAt: p.mergedAt?.toISOString() ?? null,
      closedAt: p.closedAt?.toISOString() ?? null,
    })),
    linearTickets: ticketRows.map((t) => ({
      id: t.id,
      workspaceId: t.workspaceId,
      ticketId: t.ticketId,
      ticketIdentifier: t.ticketIdentifier,
      url: t.url,
      title: t.title,
      state: t.state,
    })),
  };

  return { projectId: project.id, payload };
}

/**
 * Enqueue an agent run.completed delivery row for every enabled endpoint
 * subscribed to the event in the given project. No-op if no endpoints.
 */
export async function enqueueAgentRunCompleted(
  agentRunId: string,
  database: DB = defaultDb,
): Promise<number> {
  const built = await buildAgentRunCompletedPayload(database, agentRunId);
  if (!built) return 0;
  const endpoints = await database.query.webhookEndpoints.findMany({
    where: and(
      eq(schema.webhookEndpoints.projectId, built.projectId),
      isNull(schema.webhookEndpoints.disabledAt),
    ),
  });
  const matching = endpoints.filter((e) =>
    (e.enabledEvents ?? []).includes("agent_run.completed"),
  );
  if (matching.length === 0) return 0;
  await database.insert(schema.webhookDeliveries).values(
    matching.map((endpoint) => ({
      endpointId: endpoint.id,
      eventType: "agent_run.completed" as const,
      payload: built.payload as unknown as Record<string, unknown>,
    })),
  );
  logger.info(
    {
      scope: "webhooks.enqueue",
      agent_run_id: agentRunId,
      project_id: built.projectId,
      endpoint_count: matching.length,
    },
    "enqueued agent run.completed",
  );
  return matching.length;
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
  let responseText: string | null = null;
  let errorMessage: string | null = null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(endpoint.url, {
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
      const text = await res.text().catch(() => "");
      responseText = text.length > RESPONSE_BODY_TRUNC ? text.slice(0, RESPONSE_BODY_TRUNC) : text;
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
        lastResponseBody: responseText,
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
      lastResponseBody: responseText,
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
