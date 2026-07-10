import { type AgentRunResult, type DB, mergeIncidentsInTx, schema } from "@superlog/db";
import { and, eq } from "drizzle-orm";
import type { LifecycleEventKind } from "./domain.js";

export type AgentRunRepository = ReturnType<typeof createAgentRunRepository>;

export function createAgentRunRepository(db: DB) {
  async function insertEvent(opts: {
    agentRunId: string;
    kind: LifecycleEventKind;
    summary?: string | null;
    detail?: Record<string, unknown> | null;
    dedupeKey?: string | null;
    providerEventId?: string | null;
    processed?: boolean;
  }): Promise<void> {
    await db
      .insert(schema.incidentEvents)
      .values({
        agentRunId: opts.agentRunId,
        kind: opts.kind,
        summary: opts.summary ?? null,
        detail: opts.detail ?? null,
        providerEventId: opts.providerEventId ?? null,
        dedupeKey: opts.dedupeKey ?? null,
        processedAt: opts.processed ? new Date() : null,
      })
      .onConflictDoNothing();
  }

  return {
    async insertQueuedRun(opts: {
      incidentId: string;
      runtime: string;
    }): Promise<schema.AgentRun | null> {
      const created = await db
        .insert(schema.agentRuns)
        .values({
          incidentId: opts.incidentId,
          runtime: opts.runtime,
          state: "queued",
        })
        .returning();
      return created[0] ?? null;
    },

    async updateRun(id: string, updates: Partial<schema.AgentRun>): Promise<void> {
      await db
        .update(schema.agentRuns)
        .set({ ...updates, updatedAt: updates.updatedAt ?? new Date() })
        .where(eq(schema.agentRuns.id, id));
    },

    // Conditional transition: applies `updates` only while the run is still
    // in `fromState`, folding the state check into the UPDATE's WHERE so two
    // racing passes can't both transition. Returns false for the loser, whose
    // caller must skip its side effects.
    async updateRunIfState(
      id: string,
      fromState: schema.AgentRun["state"],
      updates: Partial<schema.AgentRun>,
    ): Promise<boolean> {
      const updated = await db
        .update(schema.agentRuns)
        .set({ ...updates, updatedAt: updates.updatedAt ?? new Date() })
        .where(and(eq(schema.agentRuns.id, id), eq(schema.agentRuns.state, fromState)))
        .returning({ id: schema.agentRuns.id });
      return updated.length > 0;
    },

    insertEvent,

    async completeRunAndMergeIncidents(opts: {
      id: string;
      result: AgentRunResult;
      completedAt: Date;
      sourceIncident: schema.Incident;
      targetIncident: schema.Incident;
    }): Promise<void> {
      await db.transaction(async (tx) => {
        await tx
          .update(schema.agentRuns)
          .set({
            state: "complete",
            result: opts.result,
            completedAt: opts.completedAt,
            updatedAt: opts.completedAt,
          })
          .where(eq(schema.agentRuns.id, opts.id));
        await mergeIncidentsInTx(tx, {
          sourceIncident: opts.sourceIncident,
          targetIncident: opts.targetIncident,
          mergedAt: opts.completedAt,
        });
      });
    },

    async appendAgentEvent(opts: {
      agentRunId: string;
      kind: string;
      summary?: string | null;
      providerEventId?: string | null;
      detail?: Record<string, unknown> | null;
    }): Promise<void> {
      await db
        .insert(schema.incidentEvents)
        .values({
          agentRunId: opts.agentRunId,
          kind: opts.kind,
          summary: opts.summary ?? null,
          providerEventId: opts.providerEventId ?? null,
          detail: opts.detail ?? null,
          processedAt: new Date(),
        })
        .onConflictDoNothing();
    },
  };
}
