import { and, eq, inArray, sql } from "drizzle-orm";
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

    // Issues whose *current* incident is this one. An issue accumulates one
    // link per incident over its life (recurrence appends a new link), so
    // "current" means the newest link by created_at. Resolution side effects
    // must only touch these — an issue that has already recurred into a newer
    // incident belongs to that investigation, not to this closing one.
    async listCurrentIssuesForIncidentInTx(tx: Tx, incidentId: string): Promise<schema.Issue[]> {
      const result = await tx.execute<Record<string, unknown>>(sql`
        SELECT i.id
        FROM issues i
        JOIN incident_issues ii ON ii.issue_id = i.id AND ii.incident_id = ${incidentId}
        JOIN LATERAL (
          SELECT cur.incident_id
          FROM incident_issues cur
          WHERE cur.issue_id = i.id
          ORDER BY cur.created_at DESC, cur.id DESC
          LIMIT 1
        ) latest ON latest.incident_id = ${incidentId}
      `);
      // postgres-js returns the row array directly; pglite (tests) wraps it
      // in { rows }. Normalize so the repository works on both drivers.
      const rows = Array.isArray(result)
        ? (result as unknown as Array<{ id: string }>)
        : ((result as unknown as { rows: Array<{ id: string }> }).rows ?? []);
      const ids = rows.map((r) => r.id);
      if (ids.length === 0) return [];
      return tx.query.issues.findMany({ where: inArray(schema.issues.id, ids) });
    },

    async updateIssueInTx(
      tx: Tx,
      issueId: string,
      updates: Partial<schema.Issue>,
    ): Promise<void> {
      await tx.update(schema.issues).set(updates).where(eq(schema.issues.id, issueId));
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

      // Repoint the source's issue links to the target, skipping issues the
      // target already links (the pair-unique index would reject those), then
      // drop any leftover duplicates.
      await tx.execute(sql`
        UPDATE incident_issues ii
        SET incident_id = ${opts.targetIncident.id}
        WHERE ii.incident_id = ${opts.sourceIncident.id}
          AND NOT EXISTS (
            SELECT 1 FROM incident_issues x
            WHERE x.incident_id = ${opts.targetIncident.id} AND x.issue_id = ii.issue_id
          )
      `);
      await tx
        .delete(schema.incidentIssues)
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
