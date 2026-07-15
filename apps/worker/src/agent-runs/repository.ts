import {
  type AgentPullRequestLifecycleContinuation,
  type AgentRunResult,
  type DB,
  mergeIncidentsInTx,
  schema,
} from "@superlog/db";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { LifecycleEventKind } from "./domain.js";

function pendingReplyInteraction(
  event: Pick<schema.IncidentEvent, "id" | "detail" | "summary" | "createdAt">,
): schema.AgentRunFollowUpInteraction {
  const origin = event.detail?.origin;
  if (origin && typeof origin === "object" && !Array.isArray(origin)) {
    const interaction = origin as Partial<schema.AgentRunFollowUpInteraction>;
    const occurredAt =
      typeof interaction.occurredAt === "string" ? Date.parse(interaction.occurredAt) : Number.NaN;
    if (
      typeof interaction.channel === "string" &&
      schema.isFollowUpTrigger(interaction.channel as schema.AgentRunTrigger) &&
      (interaction.author === null || typeof interaction.author === "string") &&
      typeof interaction.text === "string" &&
      Number.isFinite(occurredAt)
    ) {
      return interaction as schema.AgentRunFollowUpInteraction;
    }
  }
  // Legacy human_reply rows predate `detail.origin`. Never let one malformed
  // historical row permanently block the dead-session handoff: its durable
  // summary and timestamp still preserve the human's message for the
  // successor, with a neutral channel fallback.
  return {
    channel: "slack_reply",
    author: null,
    text: event.summary?.trim() || "A human replied to the investigation.",
    occurredAt: event.createdAt.toISOString(),
  };
}

function combineFollowUpInteractions(
  lifecycleInteractions: AgentPullRequestLifecycleContinuation["interaction"][],
  pendingReplyInteractions: schema.AgentRunFollowUpInteraction[],
): schema.AgentRunFollowUpInteraction[] {
  const interactionKey = (interaction: schema.AgentRunFollowUpInteraction) =>
    JSON.stringify([
      interaction.channel,
      interaction.author,
      interaction.text,
      interaction.url ?? null,
      interaction.path ?? null,
      interaction.line ?? null,
      interaction.occurredAt,
    ]);

  // A lifecycle continuation can also exist as one pending human_reply row.
  // Treat the two sources as multisets: every durable pending row survives,
  // while at most the matching number of lifecycle copies are suppressed.
  const pendingCounts = new Map<string, number>();
  for (const interaction of pendingReplyInteractions) {
    const key = interactionKey(interaction);
    pendingCounts.set(key, (pendingCounts.get(key) ?? 0) + 1);
  }
  const unmatchedLifecycle = lifecycleInteractions.filter((interaction) => {
    const key = interactionKey(interaction);
    const pendingCount = pendingCounts.get(key) ?? 0;
    if (pendingCount === 0) return true;
    pendingCounts.set(key, pendingCount - 1);
    return false;
  });
  return [...unmatchedLifecycle, ...pendingReplyInteractions].sort(
    (left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt),
  );
}

export type AgentRunRepository = ReturnType<typeof createAgentRunRepository>;

export type PauseForEventsRepositoryOutcome =
  | { kind: "parked" }
  | { kind: "run_not_running" }
  | {
      kind: "incident_not_open";
      incidentStatus: schema.Incident["status"] | null;
    };

export function isAgentRunAggregateCurrent(opts: {
  incidentStatus: schema.Incident["status"] | null;
  expectedRunId: string;
  expectedState: schema.AgentRun["state"];
  latestRun: Pick<schema.AgentRun, "id" | "state"> | null;
}): boolean {
  return (
    opts.incidentStatus === "open" &&
    opts.latestRun?.id === opts.expectedRunId &&
    opts.latestRun.state === opts.expectedState
  );
}

export function createAgentRunRepository(db: DB) {
  async function insertEvent(opts: {
    agentRunId: string;
    incidentId?: string | null;
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
        incidentId: opts.incidentId ?? null,
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

    async recordSessionTerminationPending(opts: {
      id: string;
      providerSessionId: string;
      now: Date;
    }): Promise<void> {
      await db
        .update(schema.agentRuns)
        .set({
          providerSessionStatus: "termination_pending",
          updatedAt: opts.now,
        })
        .where(
          and(
            eq(schema.agentRuns.id, opts.id),
            eq(schema.agentRuns.providerSessionId, opts.providerSessionId),
          ),
        );
    },

    async recordDetachedSessionTerminationPending(opts: {
      id: string;
      incidentId: string;
      runtime: string;
      providerSessionId: string;
    }): Promise<void> {
      await insertEvent({
        agentRunId: opts.id,
        incidentId: opts.incidentId,
        kind: "internal_agent_session_termination_pending",
        summary: "Provider session is pending termination.",
        detail: {
          runtime: opts.runtime,
          providerSessionId: opts.providerSessionId,
        },
        dedupeKey: `session_termination:${opts.providerSessionId}`,
      });
    },

    async markDetachedSessionTerminated(opts: {
      id: string;
      providerSessionId: string;
      now: Date;
    }): Promise<void> {
      await db
        .update(schema.incidentEvents)
        .set({ processedAt: opts.now })
        .where(
          and(
            eq(schema.incidentEvents.agentRunId, opts.id),
            eq(schema.incidentEvents.kind, "internal_agent_session_termination_pending"),
            eq(schema.incidentEvents.dedupeKey, `session_termination:${opts.providerSessionId}`),
            isNull(schema.incidentEvents.processedAt),
          ),
        );
    },

    async markSessionTerminated(opts: {
      id: string;
      providerSessionId: string;
      now: Date;
    }): Promise<void> {
      await db
        .update(schema.agentRuns)
        .set({ providerSessionStatus: "terminated", updatedAt: opts.now })
        .where(
          and(
            eq(schema.agentRuns.id, opts.id),
            eq(schema.agentRuns.providerSessionId, opts.providerSessionId),
            eq(schema.agentRuns.providerSessionStatus, "termination_pending"),
          ),
        );
    },

    async appendContextChangeEventIfCurrent(opts: {
      incidentId: string;
      agentRunId: string;
      activeStates: readonly string[];
      summary: string;
      dedupeKey: string;
      now: Date;
    }): Promise<boolean> {
      return db.transaction(async (tx) => {
        const incidents = await tx
          .select({ status: schema.incidents.status })
          .from(schema.incidents)
          .where(eq(schema.incidents.id, opts.incidentId))
          .orderBy(asc(schema.incidents.id))
          .for("update");
        if (incidents[0]?.status !== "open") return false;

        const current = await tx
          .update(schema.agentRuns)
          .set({ updatedAt: opts.now })
          .where(
            and(
              eq(schema.agentRuns.id, opts.agentRunId),
              eq(schema.agentRuns.incidentId, opts.incidentId),
              inArray(schema.agentRuns.state, [...opts.activeStates]),
            ),
          )
          .returning({ id: schema.agentRuns.id });
        if (!current[0]) return false;

        await tx
          .insert(schema.incidentEvents)
          .values({
            agentRunId: opts.agentRunId,
            incidentId: opts.incidentId,
            kind: "incident_context_changed",
            summary: opts.summary,
            dedupeKey: opts.dedupeKey,
            processedAt: null,
          })
          .onConflictDoNothing();
        return true;
      });
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

        // `recordInboundInteraction` takes the same Incident-first lock. A
        // reply that won the lock immediately before this handoff is therefore
        // now durable on the source run and cannot race this read. Move its
        // origin into the successor context before marking the source event
        // processed; all writes stay in this transaction so a failed enqueue
        // leaves the source run and reply untouched.
        const pendingReplyEvents = await tx
          .select({
            id: schema.incidentEvents.id,
            detail: schema.incidentEvents.detail,
            summary: schema.incidentEvents.summary,
            createdAt: schema.incidentEvents.createdAt,
          })
          .from(schema.incidentEvents)
          .where(
            and(
              eq(schema.incidentEvents.incidentId, opts.incidentId),
              eq(schema.incidentEvents.agentRunId, opts.id),
              eq(schema.incidentEvents.kind, "human_reply"),
              isNull(schema.incidentEvents.processedAt),
            ),
          )
          .orderBy(asc(schema.incidentEvents.createdAt), asc(schema.incidentEvents.id))
          .for("update");
        const interactions = combineFollowUpInteractions(
          opts.interactions,
          pendingReplyEvents.map(pendingReplyInteraction),
        );
        // PR creation takes the same Incident-first lock. Read the successor's
        // open-PR context only after acquiring it so a PR committed before the
        // handoff is always present and a settled PR is never carried forward
        // from the caller's earlier sync snapshot.
        const openPullRequestRows = await tx.query.agentPullRequests.findMany({
          where: and(
            eq(schema.agentPullRequests.incidentId, opts.incidentId),
            eq(schema.agentPullRequests.state, "open"),
          ),
          orderBy: [asc(schema.agentPullRequests.createdAt), asc(schema.agentPullRequests.id)],
          columns: {
            id: true,
            repoFullName: true,
            prNumber: true,
            url: true,
            branchName: true,
            baseBranch: true,
            state: true,
          },
        });
        const pullRequests: schema.AgentRunFollowUpPullRequest[] = openPullRequestRows.map(
          (pullRequest) => ({
            agentPrId: pullRequest.id,
            repoFullName: pullRequest.repoFullName,
            prNumber: pullRequest.prNumber,
            url: pullRequest.url,
            branchName: pullRequest.branchName,
            baseBranch: pullRequest.baseBranch,
            state: pullRequest.state,
          }),
        );

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
            triggerDetail: {
              interactions,
              pullRequests,
            },
          })
          .returning({ id: schema.agentRuns.id });
        if (!followUp) throw new Error("failed to enqueue pull request lifecycle follow-up");

        if (pendingReplyEvents.length > 0) {
          await tx
            .update(schema.incidentEvents)
            .set({ processedAt: opts.now })
            .where(
              inArray(
                schema.incidentEvents.id,
                pendingReplyEvents.map((event) => event.id),
              ),
            );
        }

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
            detail: {
              trigger,
              interactions,
              pullRequests,
            },
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

    async resumeRunIfState(opts: {
      id: string;
      fromState: schema.AgentRun["state"];
      resumeCount: number;
      dedupeKey: string;
      now: Date;
    }): Promise<boolean> {
      return db.transaction(async (tx) => {
        const updated = await tx
          .update(schema.agentRuns)
          .set({
            state: "running",
            resumeCount: opts.resumeCount,
            startedAt: opts.now,
            updatedAt: opts.now,
          })
          .where(and(eq(schema.agentRuns.id, opts.id), eq(schema.agentRuns.state, opts.fromState)))
          .returning({ id: schema.agentRuns.id });
        if (!updated[0]) return false;

        await tx
          .insert(schema.incidentEvents)
          .values({
            agentRunId: opts.id,
            kind: "resumed",
            summary: "Investigation resumed with human input.",
            dedupeKey: opts.dedupeKey,
            processedAt: opts.now,
          })
          .onConflictDoNothing();
        return true;
      });
    },

    // Starting work shares the Incident aggregate lock with resolution. If
    // resolution wins first, the worker observes the closed Incident and does
    // not resurrect the completed queued/repo-discovery row. If start wins,
    // resolution runs second and terminalizes the newly-transitioned row.
    async updateRunIfStateAndIncidentOpen(opts: {
      id: string;
      incidentId: string;
      fromState: schema.AgentRun["state"];
      updates: Partial<schema.AgentRun>;
      now: Date;
    }): Promise<boolean> {
      return db.transaction(async (tx) => {
        const incidents = await tx
          .select({ status: schema.incidents.status })
          .from(schema.incidents)
          .where(eq(schema.incidents.id, opts.incidentId))
          .orderBy(asc(schema.incidents.id))
          .for("update");
        if (incidents[0]?.status !== "open") return false;

        const updated = await tx
          .update(schema.agentRuns)
          .set({ ...opts.updates, updatedAt: opts.updates.updatedAt ?? opts.now })
          .where(
            and(
              eq(schema.agentRuns.id, opts.id),
              eq(schema.agentRuns.incidentId, opts.incidentId),
              eq(schema.agentRuns.state, opts.fromState),
            ),
          )
          .returning({ id: schema.agentRuns.id });
        return updated.length > 0;
      });
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

    async canPublishStatusUpdate(opts: {
      id: string;
      incidentId: string;
      state: schema.AgentRun["state"];
    }): Promise<boolean> {
      const [incident, latestRun] = await Promise.all([
        db.query.incidents.findFirst({
          where: eq(schema.incidents.id, opts.incidentId),
          columns: { status: true },
        }),
        db.query.agentRuns.findFirst({
          where: eq(schema.agentRuns.incidentId, opts.incidentId),
          columns: { id: true, state: true },
          orderBy: [desc(schema.agentRuns.createdAt), desc(schema.agentRuns.id)],
        }),
      ]);
      return isAgentRunAggregateCurrent({
        incidentStatus: incident?.status ?? null,
        expectedRunId: opts.id,
        expectedState: opts.state,
        latestRun: latestRun ?? null,
      });
    },

    async completeRunIfRunning(opts: {
      id: string;
      result: AgentRunResult;
      providerSessionIdToTerminate?: string;
      now: Date;
    }): Promise<boolean> {
      return db.transaction(async (tx) => {
        const updated = await tx
          .update(schema.agentRuns)
          .set({
            state: "complete",
            result: opts.result,
            ...(opts.providerSessionIdToTerminate
              ? { providerSessionStatus: "termination_pending" }
              : {}),
            completedAt: opts.now,
            updatedAt: opts.now,
          })
          .where(
            and(
              eq(schema.agentRuns.id, opts.id),
              eq(schema.agentRuns.state, "running"),
              opts.providerSessionIdToTerminate
                ? eq(schema.agentRuns.providerSessionId, opts.providerSessionIdToTerminate)
                : undefined,
            ),
          )
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
      providerSessionIdToTerminate?: string;
      sourceIncident: schema.Incident;
      targetIncident: schema.Incident;
    }): Promise<void> {
      await db.transaction(async (tx) => {
        await mergeIncidentsInTx(tx, {
          sourceIncident: opts.sourceIncident,
          targetIncident: opts.targetIncident,
          mergedAt: opts.completedAt,
        });
        await tx
          .update(schema.agentRuns)
          .set({
            state: "complete",
            result: opts.result,
            ...(opts.providerSessionIdToTerminate
              ? { providerSessionStatus: "termination_pending" }
              : {}),
            completedAt: opts.completedAt,
            updatedAt: opts.completedAt,
          })
          .where(
            and(
              eq(schema.agentRuns.id, opts.id),
              opts.providerSessionIdToTerminate
                ? eq(schema.agentRuns.providerSessionId, opts.providerSessionIdToTerminate)
                : undefined,
            ),
          );
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
