import {
  type AgentPullRequestLifecycleContinuation,
  type AgentRunResult,
  type DB,
  mergeIncidentsInTx,
  schema,
} from "@superlog/db";
import { and, asc, eq } from "drizzle-orm";
import type { LifecycleEventKind } from "./domain.js";

export type AgentRunRepository = ReturnType<typeof createAgentRunRepository>;

export type PauseForEventsRepositoryOutcome =
  | { kind: "parked" }
  | { kind: "run_not_running" }
  | {
      kind: "incident_not_open";
      incidentStatus: schema.Incident["status"] | null;
    };

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

    async handoffRunningRunToFollowUp(opts: {
      id: string;
      incidentId: string;
      runtime: string;
      interactions: AgentPullRequestLifecycleContinuation["interaction"][];
      failureResult: AgentRunResult;
      now: Date;
    }): Promise<
      | { kind: "enqueued"; agentRunId: string }
      | { kind: "superseded" }
      | { kind: "incident_not_open"; incidentStatus: schema.IncidentStatus | null }
    > {
      return db.transaction(async (tx) => {
        const incidents = await tx
          .select({ status: schema.incidents.status })
          .from(schema.incidents)
          .where(eq(schema.incidents.id, opts.incidentId))
          .orderBy(asc(schema.incidents.id))
          .for("update");
        const incidentStatus = incidents[0]?.status ?? null;
        if (incidentStatus !== "open") {
          return { kind: "incident_not_open", incidentStatus };
        }

        const [terminalized] = await tx
          .update(schema.agentRuns)
          .set({
            state: "failed",
            failureReason: "resume_failed",
            completedAt: opts.now,
            updatedAt: opts.now,
            result: opts.failureResult,
          })
          .where(
            and(
              eq(schema.agentRuns.id, opts.id),
              eq(schema.agentRuns.incidentId, opts.incidentId),
              eq(schema.agentRuns.state, "running"),
            ),
          )
          .returning({ id: schema.agentRuns.id });
        if (!terminalized) return { kind: "superseded" };

        const trigger = opts.interactions.some((interaction) => interaction.channel === "pr_closed")
          ? "pr_closed"
          : "pr_merged";
        const [followUp] = await tx
          .insert(schema.agentRuns)
          .values({
            incidentId: opts.incidentId,
            runtime: opts.runtime,
            state: "queued",
            trigger,
            triggerDetail: { interactions: opts.interactions },
          })
          .returning({ id: schema.agentRuns.id });
        if (!followUp) throw new Error("failed to enqueue pull request lifecycle follow-up");

        await tx
          .insert(schema.incidentEvents)
          .values({
            agentRunId: opts.id,
            incidentId: opts.incidentId,
            kind: "terminal_failure",
            summary: opts.failureResult.summary,
            detail: { reason: "resume_failed", category: "infrastructure" },
            dedupeKey: `terminal:failed:resume_failed:${opts.id}:pr_lifecycle_handoff`,
            processedAt: opts.now,
          })
          .onConflictDoNothing();
        await tx
          .insert(schema.incidentEvents)
          .values({
            agentRunId: followUp.id,
            incidentId: opts.incidentId,
            kind: "follow_up_queued",
            summary: `Follow-up investigation queued: an agent pull request was ${
              trigger === "pr_closed" ? "closed" : "merged"
            }.`,
            detail: { trigger, interactions: opts.interactions },
            dedupeKey: `follow_up:${followUp.id}`,
            processedAt: opts.now,
          })
          .onConflictDoNothing();
        return { kind: "enqueued", agentRunId: followUp.id };
      });
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

    // Serialize the park decision with Incident resolution. The lock order is
    // deliberately Incident first, AgentRun second: resolveIncidentInTx uses
    // that same order before completing already-parked runs, so the two paths
    // cannot deadlock or strand a running run after resolution wins.
    async pauseForEventsIfIncidentOpen(opts: {
      id: string;
      incidentId: string;
      result: AgentRunResult;
      eventSummary: string;
      now: Date;
    }): Promise<PauseForEventsRepositoryOutcome> {
      return db.transaction(async (tx) => {
        const incidents = await tx
          .select({ status: schema.incidents.status })
          .from(schema.incidents)
          .where(eq(schema.incidents.id, opts.incidentId))
          .orderBy(asc(schema.incidents.id))
          .for("update");
        const incidentStatus = incidents[0]?.status ?? null;
        if (incidentStatus !== "open") {
          return { kind: "incident_not_open", incidentStatus };
        }

        const updated = await tx
          .update(schema.agentRuns)
          .set({
            state: "awaiting_events",
            result: opts.result,
            updatedAt: opts.now,
          })
          .where(
            and(
              eq(schema.agentRuns.id, opts.id),
              eq(schema.agentRuns.incidentId, opts.incidentId),
              eq(schema.agentRuns.state, "running"),
            ),
          )
          .returning({ id: schema.agentRuns.id });
        if (!updated[0]) return { kind: "run_not_running" };

        await tx
          .insert(schema.incidentEvents)
          .values({
            agentRunId: opts.id,
            incidentId: opts.incidentId,
            kind: "awaiting_events",
            summary: opts.eventSummary,
            dedupeKey: `awaiting_events:${opts.id}:${opts.now.getTime()}`,
            processedAt: opts.now,
          })
          .onConflictDoNothing();
        return { kind: "parked" };
      });
    },

    async canPublishAwaitingEventsUpdate(opts: {
      id: string;
      incidentId: string;
    }): Promise<boolean> {
      const current = await db
        .select({ id: schema.agentRuns.id })
        .from(schema.agentRuns)
        .innerJoin(schema.incidents, eq(schema.incidents.id, schema.agentRuns.incidentId))
        .where(
          and(
            eq(schema.agentRuns.id, opts.id),
            eq(schema.agentRuns.incidentId, opts.incidentId),
            eq(schema.agentRuns.state, "awaiting_events"),
            eq(schema.incidents.status, "open"),
          ),
        )
        .limit(1);
      return current.length > 0;
    },

    async completeRunIfRunning(opts: {
      id: string;
      result: AgentRunResult;
      now: Date;
    }): Promise<boolean> {
      return db.transaction(async (tx) => {
        const updated = await tx
          .update(schema.agentRuns)
          .set({
            state: "complete",
            result: opts.result,
            completedAt: opts.now,
            updatedAt: opts.now,
          })
          .where(and(eq(schema.agentRuns.id, opts.id), eq(schema.agentRuns.state, "running")))
          .returning({ id: schema.agentRuns.id });
        if (!updated[0]) return false;

        await tx
          .insert(schema.incidentEvents)
          .values({
            agentRunId: opts.id,
            kind: "agent_run_completed",
            summary: opts.result.summary,
            dedupeKey: `completed:${opts.id}`,
            processedAt: opts.now,
          })
          .onConflictDoNothing();
        return true;
      });
    },

    async completeRunWithPullRequestIfRunning(opts: {
      id: string;
      result: AgentRunResult;
      selectedRepoFullName: string;
      selectedBaseBranch: string;
      prUrl: string;
      now: Date;
    }): Promise<boolean> {
      return db.transaction(async (tx) => {
        const updated = await tx
          .update(schema.agentRuns)
          .set({
            state: "complete",
            selectedRepoFullName: opts.selectedRepoFullName,
            selectedBaseBranch: opts.selectedBaseBranch,
            completedAt: opts.now,
            updatedAt: opts.now,
            result: opts.result,
          })
          .where(and(eq(schema.agentRuns.id, opts.id), eq(schema.agentRuns.state, "running")))
          .returning({ id: schema.agentRuns.id });
        if (!updated[0]) return false;

        await tx
          .insert(schema.incidentEvents)
          .values({
            agentRunId: opts.id,
            kind: "pr_opened",
            summary: `Opened PR: ${opts.prUrl}`,
            detail: { url: opts.prUrl },
            dedupeKey: `pr:${opts.prUrl}`,
            processedAt: opts.now,
          })
          .onConflictDoNothing();
        return true;
      });
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
