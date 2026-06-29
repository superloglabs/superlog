import { and, eq, sql } from "drizzle-orm";
import type { DB } from "./client.js";
import * as schema from "./schema.js";

export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

export type InsertIncidentEventInput = {
  incidentId: string;
  agentRunId?: string | null;
  kind: string;
  summary: string;
  detail?: Record<string, unknown>;
  dedupeKey: string;
  processedAt?: Date;
};

export type IncidentRepository = ReturnType<typeof createIncidentRepository>;

export function createIncidentRepository(database: DB) {
  return {
    transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
      return database.transaction(fn);
    },

    async updateIncident(incidentId: string, updates: Partial<schema.Incident>): Promise<void> {
      await database
        .update(schema.incidents)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(schema.incidents.id, incidentId));
    },

    async updateIncidentInTx(
      tx: Tx,
      incidentId: string,
      updates: Partial<schema.Incident>,
      updatedAt: Date,
    ): Promise<void> {
      await tx
        .update(schema.incidents)
        .set({ ...updates, updatedAt })
        .where(eq(schema.incidents.id, incidentId));
    },

    findLatestAgentRunIdInTx(tx: Tx, incidentId: string): Promise<{ id: string } | undefined> {
      return tx.query.agentRuns.findFirst({
        where: eq(schema.agentRuns.incidentId, incidentId),
        orderBy: (agentRuns, { desc }) => [desc(agentRuns.createdAt)],
        columns: { id: true },
      });
    },

    async insertEventInTx(tx: Tx, opts: InsertIncidentEventInput): Promise<void> {
      const now = opts.processedAt ?? new Date();
      await tx
        .insert(schema.incidentEvents)
        .values({
          agentRunId: opts.agentRunId ?? null,
          incidentId: opts.incidentId,
          kind: opts.kind,
          summary: opts.summary,
          detail: opts.detail ?? null,
          dedupeKey: opts.dedupeKey,
          processedAt: now,
          createdAt: now,
        })
        .onConflictDoNothing();
    },

    async resolveOpenIncidentInTx(
      tx: Tx,
      input: {
        incidentId: string;
        resolvedAt: Date;
        kind: schema.IncidentResolvedByKind;
        reasonCode: string;
        reasonText: string | null;
        resolvedByUserId?: string | null;
        resolvedBySlackUserId?: string | null;
        autoInvestigateSuppressedUntil?: Date | null;
      },
    ): Promise<boolean> {
      const updated = await tx
        .update(schema.incidents)
        .set({
          status: "resolved",
          resolvedAt: input.resolvedAt,
          resolvedByKind: input.kind,
          resolvedByUserId: input.resolvedByUserId ?? null,
          resolvedBySlackUserId: input.resolvedBySlackUserId ?? null,
          resolvedReasonCode: input.reasonCode,
          resolvedReasonText: input.reasonText,
          autoInvestigateSuppressedUntil: input.autoInvestigateSuppressedUntil ?? null,
          updatedAt: input.resolvedAt,
        })
        .where(and(eq(schema.incidents.id, input.incidentId), eq(schema.incidents.status, "open")))
        .returning({ id: schema.incidents.id });
      return updated.length > 0;
    },

    listIncidentIssueLinksInTx(tx: Tx, incidentId: string): Promise<schema.IncidentIssue[]> {
      return tx.query.incidentIssues.findMany({
        where: eq(schema.incidentIssues.incidentId, incidentId),
      });
    },

    async mergeOpenIncidentsInTx(
      tx: Tx,
      opts: {
        sourceIncident: schema.Incident;
        targetIncident: schema.Incident;
        mergedAt: Date;
      },
    ): Promise<void> {
      const newTargetLastSeen =
        opts.sourceIncident.lastSeen > opts.targetIncident.lastSeen
          ? opts.sourceIncident.lastSeen
          : opts.targetIncident.lastSeen;

      await tx
        .update(schema.incidentIssues)
        .set({ incidentId: opts.targetIncident.id })
        .where(eq(schema.incidentIssues.incidentId, opts.sourceIncident.id));
      await tx
        .update(schema.incidents)
        .set({
          status: "merged",
          mergedIntoId: opts.targetIncident.id,
          mergedAt: opts.mergedAt,
          updatedAt: opts.mergedAt,
        })
        .where(eq(schema.incidents.id, opts.sourceIncident.id));
      await tx
        .update(schema.incidents)
        .set({
          issueCount: sql`${schema.incidents.issueCount} + ${opts.sourceIncident.issueCount}`,
          lastSeen: newTargetLastSeen,
          updatedAt: opts.mergedAt,
        })
        .where(eq(schema.incidents.id, opts.targetIncident.id));
    },
  };
}
