import { type AgentRunResult, db, schema } from "@superlog/db";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { AgentRunContext } from "../agent-run-context.js";
import { logger } from "../logger.js";
import { recordFiledLinearTicket } from "./deliverable-records.js";
import { dispatchAgentRunJob } from "./enqueue.js";
import { type DeliveredLinearTicket, deliverLinearTicket } from "./linear-delivery.js";
import { linkLinearTicketToPullRequests } from "./linear-pr-linking.js";

export const LINEAR_HANDOFF_PENDING_EVENT = "linear_handoff_pending";

export type LinearHandoffReconciliationDeps = {
  deliverTicket(result: AgentRunResult, prUrls: string[]): Promise<DeliveredLinearTicket | null>;
  recordTicket(ticket: DeliveredLinearTicket): Promise<boolean>;
  linkPullRequests(
    ticket: DeliveredLinearTicket,
    prUrls: string[],
  ): Promise<{ linkedPullRequests: number; complete: boolean }>;
  markProcessed(ids: string[]): Promise<void>;
};

export type LinearHandoffSchedulingDeps = {
  recordPending(): Promise<void>;
  dispatch(): Promise<void>;
  reconcile(): Promise<DeliveredLinearTicket | null>;
};

export async function scheduleLinearHandoffWithDeps(
  input: { deliveryEnabled: boolean },
  deps: LinearHandoffSchedulingDeps,
): Promise<DeliveredLinearTicket | null> {
  if (!input.deliveryEnabled) return null;
  await deps.recordPending();
  await deps.dispatch().catch(() => undefined);
  return deps.reconcile();
}

export async function reconcileLinearHandoffWithDeps(
  input: {
    deliveryEnabled: boolean;
    pendingEventIds: string[];
    result: AgentRunResult;
    prUrls: string[];
  },
  deps: LinearHandoffReconciliationDeps,
): Promise<DeliveredLinearTicket | null> {
  if (input.pendingEventIds.length === 0) return null;
  // Disconnected Linear or a policy of never: retire the durable work instead
  // of leaving it pending forever.
  if (!input.deliveryEnabled) {
    await deps.markProcessed(input.pendingEventIds);
    return null;
  }

  const ticket = await deps.deliverTicket(input.result, input.prUrls);
  if (!ticket) return null;
  const recorded = await deps.recordTicket(ticket);
  if (!recorded) return ticket;
  const linking = await deps.linkPullRequests(ticket, input.prUrls);
  if (!linking.complete) return ticket;
  await deps.markProcessed(input.pendingEventIds);
  return ticket;
}

function resultFromPendingEvent(
  events: Array<Pick<schema.IncidentEvent, "detail">>,
  fallback: AgentRunResult | null,
  incident: Pick<schema.Incident, "agentSummary" | "title">,
): AgentRunResult {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const result = events[index]?.detail?.result;
    if (
      result &&
      typeof result === "object" &&
      typeof (result as AgentRunResult).summary === "string"
    ) {
      return result as AgentRunResult;
    }
  }
  return fallback ?? { state: "complete", summary: incident.agentSummary ?? incident.title };
}

export async function reconcilePendingLinearHandoff(
  ctx: AgentRunContext,
): Promise<DeliveredLinearTicket | null> {
  const pending = await db.query.incidentEvents.findMany({
    where: and(
      eq(schema.incidentEvents.agentRunId, ctx.agentRun.id),
      eq(schema.incidentEvents.kind, LINEAR_HANDOFF_PENDING_EVENT),
      isNull(schema.incidentEvents.processedAt),
    ),
    orderBy: [asc(schema.incidentEvents.createdAt)],
    columns: { id: true, detail: true },
  });
  if (pending.length === 0) return null;

  const pullRequests = await db.query.agentPullRequests.findMany({
    where: eq(schema.agentPullRequests.incidentId, ctx.incident.id),
    columns: { url: true },
  });
  const prUrls = [...new Set(pullRequests.map((pr) => pr.url).filter(Boolean))];
  const result = resultFromPendingEvent(pending, ctx.agentRun.result, ctx.incident);

  try {
    return await reconcileLinearHandoffWithDeps(
      {
        deliveryEnabled: !!ctx.linearInstall && ctx.linearTicketPolicy !== "never",
        pendingEventIds: pending.map((event) => event.id),
        result,
        prUrls,
      },
      {
        deliverTicket: (handoffResult, urls) =>
          deliverLinearTicket(ctx, handoffResult, { prUrls: urls }),
        recordTicket: (ticket) =>
          recordFiledLinearTicket(
            ctx,
            {
              id: ticket.ticketId,
              url: ticket.url,
              createdByAgent: ticket.created,
            },
            { identifier: ticket.identifier },
          ),
        linkPullRequests: (ticket, urls) => linkLinearTicketToPullRequests(ctx, ticket, urls),
        markProcessed: async (ids) => {
          await db
            .update(schema.incidentEvents)
            .set({ processedAt: new Date() })
            .where(inArray(schema.incidentEvents.id, ids));
        },
      },
    );
  } catch (err) {
    logger.warn(
      {
        scope: "agent_run.linear_handoff",
        agent_run_id: ctx.agentRun.id,
        incident_id: ctx.incident.id,
        err: err instanceof Error ? err.message : String(err),
      },
      "Linear handoff reconciliation failed; leaving durable work pending",
    );
    return null;
  }
}

export async function scheduleLinearHandoff(
  ctx: AgentRunContext,
  result: AgentRunResult,
  boundary: string,
): Promise<DeliveredLinearTicket | null> {
  return scheduleLinearHandoffWithDeps(
    { deliveryEnabled: !!ctx.linearInstall && ctx.linearTicketPolicy !== "never" },
    {
      recordPending: async () => {
        await db
          .insert(schema.incidentEvents)
          .values({
            agentRunId: ctx.agentRun.id,
            incidentId: ctx.incident.id,
            kind: LINEAR_HANDOFF_PENDING_EVENT,
            summary: "Linear handoff pending reconciliation.",
            detail: { result },
            providerEventId: `linear_handoff:${boundary}`,
          })
          .onConflictDoNothing();
      },
      dispatch: () => dispatchAgentRunJob(ctx.agentRun.id),
      reconcile: () => reconcilePendingLinearHandoff(ctx),
    },
  );
}

export async function listPendingLinearHandoffRunIds(limit = 500): Promise<string[]> {
  const rows = await db
    .selectDistinct({ agentRunId: schema.incidentEvents.agentRunId })
    .from(schema.incidentEvents)
    .where(
      and(
        eq(schema.incidentEvents.kind, LINEAR_HANDOFF_PENDING_EVENT),
        isNull(schema.incidentEvents.processedAt),
      ),
    )
    .limit(limit);
  return rows.map((row) => row.agentRunId).filter((id): id is string => typeof id === "string");
}
