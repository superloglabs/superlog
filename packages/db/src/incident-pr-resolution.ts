import { and, desc, eq, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import { reconcileAgentPullRequestProviderObservation } from "./agent-pr-provider-reconciliation.js";
import {
  type AgentPullRequestStateTx,
  type ApplyAgentPullRequestStateInput,
  type ApplyAgentPullRequestStateResult,
  applyAgentPullRequestStateInTx,
} from "./agent-pr-state.js";
import type { DB } from "./client.js";
import * as schema from "./schema.js";

export type IncidentOpenPullRequestToClose = {
  id: string;
  githubInstallationId: number;
  fallbackGithubInstallationIds: number[];
  repoFullName: string;
  prNumber: number;
  prNodeId: string | null;
};

type IncidentOpenPullRequestRow = Omit<
  IncidentOpenPullRequestToClose,
  "fallbackGithubInstallationIds"
> & {
  projectId: string | null;
};

export type IncidentPullRequestProviderObservation = Omit<
  ApplyAgentPullRequestStateInput,
  "incidentId" | "agentPrId" | "targetState" | "observedAt" | "providerSnapshotAuthoritative"
> & {
  targetState: schema.AgentPrState;
  observedAt: Date;
};

export type CloseIncidentPullRequestResult =
  | {
      ok: true;
      providerUpdatedAt?: Date;
      loadAuthoritativeObservation?: () => Promise<IncidentPullRequestProviderObservation>;
    }
  | { ok: false; error: string };

export type CloseIncidentPullRequest = (
  pr: IncidentOpenPullRequestToClose,
) => Promise<CloseIncidentPullRequestResult>;

export type CloseIncidentOpenPullRequestsResult = {
  closedPullRequestCount: number;
  failedPullRequestCount: number;
};

export type IncidentResolutionProof = {
  agentRunId: string | null;
  eventDedupeKey: string;
};

function incidentResolutionProofAgentRunCondition(proof: IncidentResolutionProof) {
  return proof.agentRunId === null
    ? isNull(schema.incidentEvents.agentRunId)
    : eq(schema.incidentEvents.agentRunId, proof.agentRunId);
}

function providerWatermarkAllowsMutation(providerUpdatedAt: Date | undefined) {
  // Equal provider watermarks cannot order opposite reversible states. Never
  // infer causality from local clocks written by different processes; reject
  // the blind update so the caller reads authoritative provider state.
  return providerUpdatedAt
    ? or(
        isNull(schema.agentPullRequests.providerUpdatedAt),
        lt(schema.agentPullRequests.providerUpdatedAt, providerUpdatedAt),
      )
    : isNull(schema.agentPullRequests.providerUpdatedAt);
}

type ProviderMutationCanonicalState = Pick<schema.AgentPullRequest, "state" | "providerUpdatedAt">;

function hasEqualProviderObservation(
  current: ProviderMutationCanonicalState,
  providerUpdatedAt: Date | undefined,
): boolean {
  return (
    providerUpdatedAt !== undefined &&
    current.providerUpdatedAt !== null &&
    current.providerUpdatedAt.getTime() === providerUpdatedAt.getTime()
  );
}

type IncidentResolutionEpoch = {
  status: schema.Incident["status"];
  resolvedAt: Date | null;
  eventProcessedAt: Date | null;
};

function isMatchingResolutionEpoch(epoch: IncidentResolutionEpoch | undefined): boolean {
  return (
    epoch?.status === "resolved" &&
    epoch.resolvedAt !== null &&
    epoch.eventProcessedAt !== null &&
    epoch.resolvedAt.getTime() === epoch.eventProcessedAt.getTime()
  );
}

async function loadIncidentResolutionEpoch(
  database: DB,
  incidentId: string,
  proof: IncidentResolutionProof,
): Promise<IncidentResolutionEpoch | undefined> {
  const [epoch] = await database
    .select({
      status: schema.incidents.status,
      resolvedAt: schema.incidents.resolvedAt,
      eventProcessedAt: schema.incidentEvents.processedAt,
    })
    .from(schema.incidents)
    .innerJoin(
      schema.incidentEvents,
      and(
        eq(schema.incidentEvents.incidentId, schema.incidents.id),
        incidentResolutionProofAgentRunCondition(proof),
        eq(schema.incidentEvents.kind, "incident_resolved"),
        eq(schema.incidentEvents.dedupeKey, proof.eventDedupeKey),
      ),
    )
    .where(eq(schema.incidents.id, incidentId))
    .limit(1);
  return epoch;
}

export async function isIncidentResolutionProofCurrent(opts: {
  incidentId: string;
  resolutionProof: IncidentResolutionProof;
  database?: DB;
}): Promise<boolean> {
  const database = opts.database ?? (await import("./client.js")).db;
  return isMatchingResolutionEpoch(
    await loadIncidentResolutionEpoch(database, opts.incidentId, opts.resolutionProof),
  );
}

export async function loadCurrentIncidentResolutionProof(opts: {
  incidentId: string;
  database?: DB;
}): Promise<IncidentResolutionProof | null> {
  const database = opts.database ?? (await import("./client.js")).db;
  const [event] = await database
    .select({
      agentRunId: schema.incidentEvents.agentRunId,
      eventDedupeKey: schema.incidentEvents.dedupeKey,
    })
    .from(schema.incidents)
    .innerJoin(
      schema.incidentEvents,
      and(
        eq(schema.incidentEvents.incidentId, schema.incidents.id),
        eq(schema.incidentEvents.kind, "incident_resolved"),
        eq(schema.incidentEvents.processedAt, schema.incidents.resolvedAt),
        isNotNull(schema.incidentEvents.dedupeKey),
      ),
    )
    .where(and(eq(schema.incidents.id, opts.incidentId), eq(schema.incidents.status, "resolved")))
    .orderBy(desc(schema.incidentEvents.createdAt))
    .limit(1);
  if (!event?.eventDedupeKey) return null;
  return { agentRunId: event.agentRunId, eventDedupeKey: event.eventDedupeKey };
}

async function applySuccessfulProviderMutationInTx(opts: {
  tx: AgentPullRequestStateTx;
  incidentId: string;
  pr: IncidentOpenPullRequestToClose;
  mutation: Extract<CloseIncidentPullRequestResult, { ok: true }>;
  targetState: "open" | "closed";
  observedAt: Date;
}): Promise<ApplyAgentPullRequestStateResult> {
  const reconciliation = await reconcileAgentPullRequestProviderObservation(
    {
      targetState: opts.targetState,
      observedAt: opts.observedAt,
      providerUpdatedAt: opts.mutation.providerUpdatedAt,
      closedAt:
        opts.targetState === "open" ? null : (opts.mutation.providerUpdatedAt ?? opts.observedAt),
    },
    {
      async applyObservation(observation) {
        const applied = await applyAgentPullRequestStateInTx(opts.tx, {
          incidentId: opts.incidentId,
          agentPrId: opts.pr.id,
          ...observation,
        });
        return {
          ...applied,
          pullRequestState: applied.pullRequest?.state ?? null,
        };
      },
      async loadAuthoritativeObservation() {
        if (!opts.mutation.loadAuthoritativeObservation) {
          throw new Error(
            `authoritative provider state is required to reconcile PR #${opts.pr.prNumber}`,
          );
        }
        return opts.mutation.loadAuthoritativeObservation();
      },
    },
  );
  return reconciliation.mutation;
}

async function reconcileAmbiguousProviderMutation(opts: {
  database: DB;
  incidentId: string;
  pr: IncidentOpenPullRequestToClose;
  mutation: Extract<CloseIncidentPullRequestResult, { ok: true }>;
  closePullRequest: CloseIncidentPullRequest;
  reopenPullRequest?: CloseIncidentPullRequest;
  followIncidentStatus: boolean;
  now: () => Date;
}): Promise<schema.AgentPullRequest> {
  if (!opts.mutation.loadAuthoritativeObservation) {
    throw new Error(
      `authoritative provider state is required to reconcile PR #${opts.pr.prNumber}`,
    );
  }
  const observation = await opts.mutation.loadAuthoritativeObservation();
  return opts.database.transaction(async (tx) => {
    // Applying through the in-transaction state primitive establishes the
    // aggregate's Incident -> PR lock order. Keep that Incident lock through
    // the one bounded provider compensation below so an epoch cannot change
    // between choosing the desired state and committing it.
    const reconciliation = await applyAgentPullRequestStateInTx(tx, {
      incidentId: opts.incidentId,
      agentPrId: opts.pr.id,
      ...observation,
      providerSnapshotAuthoritative: true,
    });
    if (!reconciliation.pullRequest) {
      throw new Error(`agent PR ${opts.pr.id} disappeared during provider reconciliation`);
    }
    if (reconciliation.providerReconciliationRequired) {
      throw new Error(`authoritative provider state remained ambiguous for agent PR ${opts.pr.id}`);
    }
    if (reconciliation.pullRequest.state === "merged") return reconciliation.pullRequest;

    const [incident] = await tx
      .select({ status: schema.incidents.status })
      .from(schema.incidents)
      .where(eq(schema.incidents.id, opts.incidentId))
      .for("update");
    if (!incident) {
      throw new Error(`incident ${opts.incidentId} disappeared during provider reconciliation`);
    }
    const desiredState =
      opts.followIncidentStatus && incident.status === "open" ? "open" : "closed";
    if (reconciliation.pullRequest.state === desiredState) return reconciliation.pullRequest;

    const compensate = desiredState === "open" ? opts.reopenPullRequest : opts.closePullRequest;
    if (!compensate) {
      throw new Error(
        `no pull request ${desiredState === "open" ? "reopen" : "close"} compensation was configured`,
      );
    }
    const compensation = await compensate(opts.pr);
    if (!compensation.ok) {
      throw new Error(
        `failed to restore provider pull request state to ${desiredState}: ${compensation.error}`,
      );
    }
    const observedAt = opts.now();
    const compensated = await applySuccessfulProviderMutationInTx({
      tx,
      incidentId: opts.incidentId,
      pr: opts.pr,
      mutation: compensation,
      targetState: desiredState,
      observedAt,
    });
    if (!compensated.pullRequest) {
      throw new Error(`agent PR ${opts.pr.id} disappeared during provider compensation`);
    }
    if (
      compensated.providerReconciliationRequired ||
      (compensated.pullRequest.state !== desiredState && compensated.pullRequest.state !== "merged")
    ) {
      throw new Error(`provider compensation did not settle agent PR ${opts.pr.id}`);
    }
    return compensated.pullRequest;
  });
}

async function settleSuccessfulResolutionCompensationReopen(opts: {
  database: DB;
  incidentId: string;
  pr: IncidentOpenPullRequestToClose;
  mutation: Extract<CloseIncidentPullRequestResult, { ok: true }>;
  closePullRequest: CloseIncidentPullRequest;
  reopenedAt: Date;
  now: () => Date;
}): Promise<schema.AgentPullRequest | "provider_state_ambiguous" | "provider_state_superseded"> {
  // A mutation response without a provider clock cannot be ordered against
  // any existing canonical watermark. Read the provider before projecting
  // the result instead of treating local arrival time as authority.
  if (opts.mutation.providerUpdatedAt === undefined) return "provider_state_ambiguous";
  return opts.database.transaction(async (tx) => {
    // The provider reopen has already succeeded. Apply its response through
    // the aggregate lock primitive, then keep the Incident lock until the
    // provider and canonical PR settle against the current Incident status
    // and provider ordering.
    const reopened = await applyAgentPullRequestStateInTx(tx, {
      incidentId: opts.incidentId,
      agentPrId: opts.pr.id,
      targetState: "open",
      observedAt: opts.reopenedAt,
      providerUpdatedAt: opts.mutation.providerUpdatedAt,
      closedAt: null,
    });
    if (!reopened.pullRequest) {
      throw new Error(`agent PR ${opts.pr.id} disappeared during provider reopen settlement`);
    }
    if (reopened.pullRequest.state === "merged") return reopened.pullRequest;

    const [incident] = await tx
      .select({ status: schema.incidents.status })
      .from(schema.incidents)
      .where(eq(schema.incidents.id, opts.incidentId))
      .for("update");
    if (!incident) {
      throw new Error(`incident ${opts.incidentId} disappeared during provider reopen settlement`);
    }
    const desiredState = incident.status === "open" ? "open" : "closed";

    // When the Incident still wants the state just requested from the
    // provider, an equal-second conflicting observation must be settled by
    // an authoritative read outside this transaction.
    if (desiredState === "open" && reopened.providerReconciliationRequired) {
      return "provider_state_ambiguous";
    }

    // A successful provider reopen must be reversed whenever a newer
    // terminal Incident epoch won, even if a newer canonical watermark had
    // already kept the database row closed. When the Incident remains open,
    // preserve a newer provider observation instead of retrying an older
    // mutation response over it.
    if (desiredState === "open") {
      return reopened.pullRequest.state === "open"
        ? reopened.pullRequest
        : "provider_state_superseded";
    }
    const compensation = await opts.closePullRequest(opts.pr);
    if (!compensation.ok) {
      throw new Error(
        `failed to restore provider pull request state to closed: ${compensation.error}`,
      );
    }
    const observedAt = opts.now();
    const compensated = await applySuccessfulProviderMutationInTx({
      tx,
      incidentId: opts.incidentId,
      pr: opts.pr,
      mutation: compensation,
      targetState: "closed",
      observedAt,
    });
    if (!compensated.pullRequest) {
      throw new Error(`agent PR ${opts.pr.id} disappeared during provider reopen compensation`);
    }
    if (
      compensated.providerReconciliationRequired ||
      (compensated.pullRequest.state !== "closed" && compensated.pullRequest.state !== "merged")
    ) {
      throw new Error(`provider reopen compensation did not settle agent PR ${opts.pr.id}`);
    }
    return compensated.pullRequest;
  });
}

async function recordResolutionClosedPullRequestEvent(
  database: DB,
  pr: IncidentOpenPullRequestToClose,
  occurredAt: Date,
): Promise<void> {
  await database
    .insert(schema.agentPrEvents)
    .values({
      agentPrId: pr.id,
      kind: "pr_closed",
      summary: `Closed PR #${pr.prNumber} because the incident was resolved.`,
      payload: { repoFullName: pr.repoFullName, prNumber: pr.prNumber },
      providerEventId: `pr_closed:incident_resolved:${pr.id}`,
      occurredAt,
    })
    .onConflictDoNothing();
}

async function recordResolutionCompensationReopenEvent(opts: {
  database: DB;
  pr: IncidentOpenPullRequestToClose;
  resolutionProof: IncidentResolutionProof;
  occurredAt: Date;
}): Promise<void> {
  await opts.database
    .insert(schema.agentPrEvents)
    .values({
      agentPrId: opts.pr.id,
      kind: "pr_reopened",
      summary: `Reopened PR #${opts.pr.prNumber} because the incident resolution changed during closure.`,
      payload: { repoFullName: opts.pr.repoFullName, prNumber: opts.pr.prNumber },
      providerEventId: `pr_reopened:resolution_compensation:${opts.pr.id}:${opts.resolutionProof.eventDedupeKey}`,
      occurredAt: opts.occurredAt,
    })
    .onConflictDoNothing();
}

export async function closeIncidentOpenPullRequestsAfterResolution(opts: {
  incidentId: string;
  resolutionProof?: IncidentResolutionProof;
  closePullRequest: CloseIncidentPullRequest;
  reopenPullRequest?: CloseIncidentPullRequest;
  database?: DB;
  now?: () => Date;
  onCloseFailure?: (input: { pr: IncidentOpenPullRequestToClose; error: string }) => void;
}): Promise<CloseIncidentOpenPullRequestsResult> {
  const database = opts.database ?? (await import("./client.js")).db;
  if (
    opts.resolutionProof &&
    !(await isIncidentResolutionProofCurrent({
      incidentId: opts.incidentId,
      resolutionProof: opts.resolutionProof,
      database,
    }))
  ) {
    return { closedPullRequestCount: 0, failedPullRequestCount: 0 };
  }
  return closeIncidentOpenPullRequests({ ...opts, database });
}

async function closeIncidentOpenPullRequests(opts: {
  incidentId: string;
  resolutionProof?: IncidentResolutionProof;
  closePullRequest: CloseIncidentPullRequest;
  reopenPullRequest?: CloseIncidentPullRequest;
  database: DB;
  now?: () => Date;
  onCloseFailure?: (input: { pr: IncidentOpenPullRequestToClose; error: string }) => void;
}): Promise<CloseIncidentOpenPullRequestsResult> {
  const database = opts.database;
  const now = opts.now ?? (() => new Date());
  const rows = (await database
    .select({
      id: schema.agentPullRequests.id,
      projectId: schema.incidents.projectId,
      repoFullName: schema.agentPullRequests.repoFullName,
      prNumber: schema.agentPullRequests.prNumber,
      prNodeId: schema.agentPullRequests.prNodeId,
      githubInstallationId: schema.githubInstallations.installationId,
    })
    .from(schema.agentPullRequests)
    .innerJoin(
      schema.githubInstallations,
      eq(schema.githubInstallations.id, schema.agentPullRequests.installationId),
    )
    .innerJoin(schema.incidents, eq(schema.incidents.id, schema.agentPullRequests.incidentId))
    .where(
      and(
        eq(schema.agentPullRequests.incidentId, opts.incidentId),
        eq(schema.agentPullRequests.state, "open"),
      ),
    )) as IncidentOpenPullRequestRow[];

  const fallbackInstallationIdsByProjectId = await loadFallbackInstallationIdsByProjectId(
    database,
    rows,
  );

  let closedPullRequestCount = 0;
  let failedPullRequestCount = 0;
  for (const row of rows) {
    const { projectId, ...prWithoutProject } = row;
    const fallbackGithubInstallationIds = dedupeInstallationIds(
      fallbackInstallationIdsByProjectId.get(projectId ?? "") ?? [],
    ).filter((installationId) => installationId !== row.githubInstallationId);
    const pr: IncidentOpenPullRequestToClose = {
      ...prWithoutProject,
      fallbackGithubInstallationIds,
    };
    if (
      opts.resolutionProof &&
      !(await isIncidentResolutionProofCurrent({
        incidentId: opts.incidentId,
        resolutionProof: opts.resolutionProof,
        database,
      }))
    ) {
      break;
    }
    const closedAt = now();
    const result = await opts.closePullRequest(pr);
    if (!result.ok) {
      failedPullRequestCount += 1;
      opts.onCloseFailure?.({ pr, error: result.error });
      continue;
    }

    if (result.providerUpdatedAt === undefined) {
      try {
        const canonicalPr = await reconcileAmbiguousProviderMutation({
          database,
          incidentId: opts.incidentId,
          pr,
          mutation: result,
          closePullRequest: opts.closePullRequest,
          reopenPullRequest: opts.reopenPullRequest,
          followIncidentStatus: opts.resolutionProof !== undefined,
          now,
        });
        if (canonicalPr.state === "closed") {
          await recordResolutionClosedPullRequestEvent(
            database,
            pr,
            canonicalPr.lastSyncedAt ?? closedAt,
          );
        }
        if (opts.resolutionProof && canonicalPr.state === "open") {
          await recordResolutionCompensationReopenEvent({
            database,
            pr,
            resolutionProof: opts.resolutionProof,
            occurredAt: canonicalPr.lastSyncedAt ?? closedAt,
          });
        } else if (canonicalPr.state !== "open") {
          closedPullRequestCount += 1;
        }
      } catch (error) {
        failedPullRequestCount += 1;
        opts.onCloseFailure?.({
          pr,
          error: `provider close returned no ordering watermark; failed to read authoritative pull request state: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      continue;
    }

    if (opts.resolutionProof) {
      const finalization = await finalizePullRequestCloseForResolutionEpoch({
        database,
        incidentId: opts.incidentId,
        resolutionProof: opts.resolutionProof,
        pr,
        closedAt,
        providerUpdatedAt: result.providerUpdatedAt,
      });
      if (finalization === "incident_open") {
        const compensated = opts.reopenPullRequest
          ? await opts.reopenPullRequest(pr)
          : {
              ok: false as const,
              error: "no pull request reopen compensation was configured",
            };
        if (!compensated.ok) {
          failedPullRequestCount += 1;
          opts.onCloseFailure?.({
            pr,
            error: `incident resolution changed during provider close; failed to reopen pull request: ${compensated.error}`,
          });
          continue;
        }
        const reopenedAt = now();
        try {
          const settlement = await settleSuccessfulResolutionCompensationReopen({
            database,
            incidentId: opts.incidentId,
            pr,
            mutation: compensated,
            closePullRequest: opts.closePullRequest,
            reopenedAt,
            now,
          });
          if (settlement === "provider_state_superseded") continue;
          const canonicalPr =
            settlement === "provider_state_ambiguous"
              ? await reconcileAmbiguousProviderMutation({
                  database,
                  incidentId: opts.incidentId,
                  pr,
                  mutation: compensated,
                  closePullRequest: opts.closePullRequest,
                  reopenPullRequest: opts.reopenPullRequest,
                  followIncidentStatus: true,
                  now,
                })
              : settlement;
          if (canonicalPr.state === "open") {
            await recordResolutionCompensationReopenEvent({
              database,
              pr,
              resolutionProof: opts.resolutionProof,
              occurredAt: canonicalPr.lastSyncedAt ?? reopenedAt,
            });
          } else {
            if (canonicalPr.state === "closed") {
              await recordResolutionClosedPullRequestEvent(
                database,
                pr,
                canonicalPr.lastSyncedAt ?? reopenedAt,
              );
            }
            closedPullRequestCount += 1;
          }
        } catch (error) {
          failedPullRequestCount += 1;
          opts.onCloseFailure?.({
            pr,
            error: `failed to settle provider reopen outcome: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
        continue;
      }
      if (finalization === "provider_state_ambiguous") {
        try {
          const canonicalPr = await reconcileAmbiguousProviderMutation({
            database,
            incidentId: opts.incidentId,
            pr,
            mutation: result,
            closePullRequest: opts.closePullRequest,
            reopenPullRequest: opts.reopenPullRequest,
            followIncidentStatus: true,
            now,
          });
          if (canonicalPr.state === "closed") {
            await recordResolutionClosedPullRequestEvent(
              database,
              pr,
              canonicalPr.lastSyncedAt ?? closedAt,
            );
          }
          if (canonicalPr.state === "open") {
            await recordResolutionCompensationReopenEvent({
              database,
              pr,
              resolutionProof: opts.resolutionProof,
              occurredAt: canonicalPr.lastSyncedAt ?? closedAt,
            });
          } else {
            closedPullRequestCount += 1;
          }
        } catch (error) {
          failedPullRequestCount += 1;
          opts.onCloseFailure?.({
            pr,
            error: `provider close outcome was ambiguous; failed to read authoritative pull request state: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
        continue;
      }
      if (finalization === "provider_state_superseded") continue;
      closedPullRequestCount += 1;
      continue;
    }

    const [updated] = await database
      .update(schema.agentPullRequests)
      .set({
        state: "closed",
        closedAt,
        lastSyncedAt: closedAt,
        ...(result.providerUpdatedAt ? { providerUpdatedAt: result.providerUpdatedAt } : {}),
        updatedAt: closedAt,
      })
      .where(
        and(
          eq(schema.agentPullRequests.id, pr.id),
          eq(schema.agentPullRequests.state, "open"),
          providerWatermarkAllowsMutation(result.providerUpdatedAt),
        ),
      )
      .returning({ id: schema.agentPullRequests.id });
    if (!updated) {
      const [currentPullRequest] = await database
        .select({
          state: schema.agentPullRequests.state,
          providerUpdatedAt: schema.agentPullRequests.providerUpdatedAt,
          lastSyncedAt: schema.agentPullRequests.lastSyncedAt,
        })
        .from(schema.agentPullRequests)
        .where(eq(schema.agentPullRequests.id, pr.id))
        .limit(1);
      if (
        currentPullRequest?.state === "open" &&
        hasEqualProviderObservation(currentPullRequest, result.providerUpdatedAt)
      ) {
        try {
          const canonicalPr = await reconcileAmbiguousProviderMutation({
            database,
            incidentId: opts.incidentId,
            pr,
            mutation: result,
            closePullRequest: opts.closePullRequest,
            reopenPullRequest: opts.reopenPullRequest,
            followIncidentStatus: false,
            now,
          });
          if (canonicalPr.state === "closed") {
            await recordResolutionClosedPullRequestEvent(
              database,
              pr,
              canonicalPr.lastSyncedAt ?? closedAt,
            );
          }
          if (canonicalPr.state !== "open") closedPullRequestCount += 1;
        } catch (error) {
          failedPullRequestCount += 1;
          opts.onCloseFailure?.({
            pr,
            error: `provider close outcome was ambiguous; failed to read authoritative pull request state: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
      continue;
    }
    await database
      .insert(schema.agentPrEvents)
      .values({
        agentPrId: pr.id,
        kind: "pr_closed",
        summary: `Closed PR #${pr.prNumber} because the incident was resolved.`,
        payload: { repoFullName: pr.repoFullName, prNumber: pr.prNumber },
        providerEventId: `pr_closed:incident_resolved:${pr.id}`,
        occurredAt: closedAt,
      })
      .onConflictDoNothing();
    closedPullRequestCount += 1;
  }

  return { closedPullRequestCount, failedPullRequestCount };
}

async function finalizePullRequestCloseForResolutionEpoch(opts: {
  database: DB;
  incidentId: string;
  resolutionProof: IncidentResolutionProof;
  pr: IncidentOpenPullRequestToClose;
  closedAt: Date;
  providerUpdatedAt?: Date;
}): Promise<
  | "current_resolution"
  | "incident_open"
  | "newer_closed_epoch"
  | "provider_state_superseded"
  | "provider_state_ambiguous"
> {
  return opts.database.transaction(async (tx) => {
    const [incident] = await tx
      .select({ status: schema.incidents.status, resolvedAt: schema.incidents.resolvedAt })
      .from(schema.incidents)
      .where(eq(schema.incidents.id, opts.incidentId))
      .for("update");
    if (!incident) return "newer_closed_epoch";
    const [event] = await tx
      .select({ eventProcessedAt: schema.incidentEvents.processedAt })
      .from(schema.incidentEvents)
      .where(
        and(
          eq(schema.incidentEvents.incidentId, opts.incidentId),
          incidentResolutionProofAgentRunCondition(opts.resolutionProof),
          eq(schema.incidentEvents.kind, "incident_resolved"),
          eq(schema.incidentEvents.dedupeKey, opts.resolutionProof.eventDedupeKey),
        ),
      )
      .limit(1);
    const currentResolution = isMatchingResolutionEpoch({
      ...incident,
      eventProcessedAt: event?.eventProcessedAt ?? null,
    });
    // A stale provider close needs compensation only while the aggregate is
    // actually open. If a newer terminal epoch already won, the provider
    // close is still correct; reconcile the canonical PR under that same
    // Incident lock and never reopen it for the obsolete proof.
    if (!currentResolution && incident.status === "open") return "incident_open";

    const [updated] = await tx
      .update(schema.agentPullRequests)
      .set({
        state: "closed",
        closedAt: opts.closedAt,
        lastSyncedAt: opts.closedAt,
        ...(opts.providerUpdatedAt ? { providerUpdatedAt: opts.providerUpdatedAt } : {}),
        updatedAt: opts.closedAt,
      })
      .where(
        and(
          eq(schema.agentPullRequests.id, opts.pr.id),
          eq(schema.agentPullRequests.state, "open"),
          providerWatermarkAllowsMutation(opts.providerUpdatedAt),
        ),
      )
      .returning({ id: schema.agentPullRequests.id });
    if (updated) {
      await tx
        .insert(schema.agentPrEvents)
        .values({
          agentPrId: opts.pr.id,
          kind: "pr_closed",
          summary: `Closed PR #${opts.pr.prNumber} because the incident was resolved.`,
          payload: { repoFullName: opts.pr.repoFullName, prNumber: opts.pr.prNumber },
          providerEventId: `pr_closed:incident_resolved:${opts.pr.id}`,
          occurredAt: opts.closedAt,
        })
        .onConflictDoNothing();
    }
    if (!updated) {
      const [currentPullRequest] = await tx
        .select({
          state: schema.agentPullRequests.state,
          providerUpdatedAt: schema.agentPullRequests.providerUpdatedAt,
          lastSyncedAt: schema.agentPullRequests.lastSyncedAt,
        })
        .from(schema.agentPullRequests)
        .where(eq(schema.agentPullRequests.id, opts.pr.id))
        .limit(1);
      if (currentPullRequest?.state === "open") {
        if (hasEqualProviderObservation(currentPullRequest, opts.providerUpdatedAt)) {
          return "provider_state_ambiguous";
        }
        return "provider_state_superseded";
      }
    }
    return currentResolution ? "current_resolution" : "newer_closed_epoch";
  });
}

async function loadFallbackInstallationIdsByProjectId(
  database: DB,
  rows: IncidentOpenPullRequestRow[],
): Promise<Map<string, number[]>> {
  const projectIds = dedupeStrings(rows.map((row) => row.projectId).filter((id) => id !== null));
  const result = new Map<string, number[]>();
  if (projectIds.length === 0) return result;

  const projectInstallations = await database
    .select({
      projectId: schema.githubInstallations.projectId,
      githubInstallationId: schema.githubInstallations.installationId,
    })
    .from(schema.githubInstallations)
    .where(
      and(
        inArray(schema.githubInstallations.projectId, projectIds),
        isNull(schema.githubInstallations.revokedAt),
      ),
    );

  const projectRepoInstallations = await database
    .select({
      projectId: schema.projectGithubRepos.projectId,
      githubInstallationId: schema.githubInstallations.installationId,
    })
    .from(schema.projectGithubRepos)
    .innerJoin(
      schema.githubInstallations,
      eq(schema.githubInstallations.id, schema.projectGithubRepos.installationId),
    )
    .where(
      and(
        inArray(schema.projectGithubRepos.projectId, projectIds),
        isNull(schema.githubInstallations.revokedAt),
      ),
    );

  for (const row of [...projectInstallations, ...projectRepoInstallations]) {
    if (!row.projectId) continue;
    const installationIds = result.get(row.projectId) ?? [];
    installationIds.push(row.githubInstallationId);
    result.set(row.projectId, installationIds);
  }
  return result;
}

function dedupeStrings(values: (string | null)[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (value) seen.add(value);
  }
  return [...seen];
}

function dedupeInstallationIds(values: number[]): number[] {
  const seen = new Set<number>();
  for (const value of values) seen.add(value);
  return [...seen];
}
