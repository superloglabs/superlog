import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
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

export type LockedOpenIncident = schema.Incident;

export type LinkableIssue = Pick<schema.Issue, "id" | "lastSeen" | "service">;

// In-tx view of an incident's PRs taken under the incident lock. Rich enough
// for a resolver to both validate the settle guard and attribute the
// resolution (merged sibling vs plain close) from one consistent snapshot.
export type IncidentAgentPullRequestSnapshot = Pick<
  schema.AgentPullRequest,
  "id" | "state" | "prNumber" | "repoFullName" | "url" | "mergedAt"
>;

async function lockIncidentsByIdInTx(tx: Tx, incidentIds: string[]): Promise<schema.Incident[]> {
  const ids = [...new Set(incidentIds)].sort();
  if (ids.length === 0) return [];
  // A merge takes two Incident locks. Always acquire them in database ID
  // order so opposing A→B / B→A attempts cannot deadlock each other.
  return tx
    .select()
    .from(schema.incidents)
    .where(inArray(schema.incidents.id, ids))
    .orderBy(asc(schema.incidents.id))
    .for("update");
}

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

    async lockOpenIncidentInTx(tx: Tx, incidentId: string): Promise<LockedOpenIncident | null> {
      const incident = (await lockIncidentsByIdInTx(tx, [incidentId]))[0];
      return incident?.status === "open" ? incident : null;
    },

    lockIncidentsInTx(tx: Tx, incidentIds: string[]): Promise<schema.Incident[]> {
      return lockIncidentsByIdInTx(tx, incidentIds);
    },

    async linkIssueInTx(
      tx: Tx,
      incident: LockedOpenIncident,
      issue: LinkableIssue,
      updatedAt: Date,
    ): Promise<boolean> {
      const inserted = await tx
        .insert(schema.incidentIssues)
        .values({ incidentId: incident.id, issueId: issue.id })
        .onConflictDoNothing()
        .returning({ id: schema.incidentIssues.id });
      if (!inserted[0]) return false;

      await tx
        .update(schema.incidents)
        .set({
          lastSeen: sql`GREATEST(${schema.incidents.lastSeen}, ${issue.lastSeen.toISOString()}::timestamptz)`,
          issueCount: sql`${schema.incidents.issueCount} + 1`,
          service: incident.service ?? issue.service,
          updatedAt,
        })
        .where(eq(schema.incidents.id, incident.id));
      return true;
    },

    async lockLatestAgentRunInTx(
      tx: Tx,
      incidentId: string,
    ): Promise<Pick<schema.AgentRun, "id" | "state"> | null> {
      const [run] = await tx
        .select({ id: schema.agentRuns.id, state: schema.agentRuns.state })
        .from(schema.agentRuns)
        .where(eq(schema.agentRuns.incidentId, incidentId))
        .orderBy(desc(schema.agentRuns.createdAt), desc(schema.agentRuns.id))
        .limit(1)
        .for("update");
      return run ?? null;
    },

    // Selected columns cover resolution attribution (e.g. crediting a merged
    // sibling from the same locked snapshot the settle guard validates), not
    // just the state predicate.
    listAgentPullRequestStatesInTx(
      tx: Tx,
      incidentId: string,
    ): Promise<IncidentAgentPullRequestSnapshot[]> {
      return tx.query.agentPullRequests.findMany({
        where: eq(schema.agentPullRequests.incidentId, incidentId),
        columns: {
          id: true,
          state: true,
          prNumber: true,
          repoFullName: true,
          url: true,
          mergedAt: true,
        },
      });
    },

    listOpenAgentPullRequestsInTx(
      tx: Tx,
      incidentId: string,
    ): Promise<Array<Pick<schema.AgentPullRequest, "repoFullName" | "prNumber" | "url">>> {
      return tx.query.agentPullRequests.findMany({
        where: and(
          eq(schema.agentPullRequests.incidentId, incidentId),
          eq(schema.agentPullRequests.state, "open"),
        ),
        orderBy: [asc(schema.agentPullRequests.createdAt), asc(schema.agentPullRequests.id)],
        columns: { repoFullName: true, prNumber: true, url: true },
      });
    },

    async hasUnprocessedIncidentEventKindInTx(
      tx: Tx,
      incidentId: string,
      kind: string,
    ): Promise<boolean> {
      const event = await tx.query.incidentEvents.findFirst({
        where: and(
          eq(schema.incidentEvents.incidentId, incidentId),
          eq(schema.incidentEvents.kind, kind),
          isNull(schema.incidentEvents.processedAt),
        ),
        columns: { id: true },
      });
      return event !== undefined;
    },

    async hasIncidentResolutionEventInTx(
      tx: Tx,
      incidentId: string,
      dedupeKey: string,
    ): Promise<boolean> {
      const event = await tx.query.incidentEvents.findFirst({
        where: and(
          eq(schema.incidentEvents.incidentId, incidentId),
          eq(schema.incidentEvents.kind, "incident_resolved"),
          eq(schema.incidentEvents.dedupeKey, dedupeKey),
        ),
        columns: { id: true },
      });
      return event !== undefined;
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

    async completeRunsSupersededByResolutionInTx(
      tx: Tx,
      incidentId: string,
      completedAt: Date,
      resolvingAgentRunId?: string | null,
    ): Promise<void> {
      const incidentRuns = await tx
        .select({
          id: schema.agentRuns.id,
          state: schema.agentRuns.state,
          result: schema.agentRuns.result,
          providerSessionId: schema.agentRuns.providerSessionId,
          providerSessionStatus: schema.agentRuns.providerSessionStatus,
        })
        .from(schema.agentRuns)
        .where(eq(schema.agentRuns.incidentId, incidentId))
        .for("update");

      for (const run of incidentRuns) {
        if (run.id === resolvingAgentRunId) continue;
        const isActive = !["complete", "failed", "superseded"].includes(run.state);
        if (!isActive) {
          if (run.providerSessionId && run.providerSessionStatus !== "terminated") {
            await tx
              .update(schema.agentRuns)
              .set({ providerSessionStatus: "termination_pending", updatedAt: completedAt })
              .where(eq(schema.agentRuns.id, run.id));
          }
          continue;
        }
        const result: schema.AgentRunResult = run.result
          ? { ...run.result, state: "complete" }
          : {
              state: "complete",
              summary: "Incident resolved; no further investigation is needed.",
            };
        await tx
          .update(schema.agentRuns)
          .set({
            state: "complete",
            result,
            completedAt,
            updatedAt: completedAt,
            ...(run.providerSessionId && run.providerSessionStatus !== "terminated"
              ? { providerSessionStatus: "termination_pending" }
              : {}),
          })
          .where(eq(schema.agentRuns.id, run.id));
        await tx
          .insert(schema.incidentEvents)
          .values({
            agentRunId: run.id,
            incidentId,
            kind: "agent_run_completed",
            summary: result.summary,
            detail: { reason: "incident_resolved" },
            dedupeKey: `completed:${run.id}`,
            processedAt: completedAt,
            createdAt: completedAt,
          })
          .onConflictDoNothing();
      }
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

    async updateIssueInTx(tx: Tx, issueId: string, updates: Partial<schema.Issue>): Promise<void> {
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
