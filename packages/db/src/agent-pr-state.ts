import { and, asc, count, eq, sql } from "drizzle-orm";
import type { DB } from "./client.js";
import * as schema from "./schema.js";

export type ApplyAgentPullRequestStateInput = {
  incidentId: string;
  agentPrId: string;
  targetState?: schema.AgentPrState;
  observedAt?: Date;
  providerUpdatedAt?: Date;
  providerSnapshotAuthoritative?: boolean;
  headSha?: string | null;
  title?: string | null;
  mergedAt?: Date | null;
  closedAt?: Date | null;
  mergedByLogin?: string | null;
  mergedByGithubId?: number | null;
};

export type ApplyAgentPullRequestStateResult = {
  pullRequest: schema.AgentPullRequest | null;
  previousState: schema.AgentPrState | null;
  stateChanged: boolean;
  providerReconciliationRequired: boolean;
};

export type AgentPullRequestStateTx = Parameters<Parameters<DB["transaction"]>[0]>[0];

export const AGENT_PULL_REQUEST_REVIEW_CONTINUATION_LIMIT = 100;
const REVIEW_CONTINUATION_EVENT_KINDS = [
  "issue_comment",
  "review_comment",
  "review_commented",
  "review_changes_requested",
  "review_approved",
] as const;
const REVIEW_CONTINUATION_LIMIT_EVENT_KIND = "review_continuation_limit_reached";
const REVIEW_CONTINUATION_LIMIT_PROVIDER_EVENT_ID = "review-continuation-limit-reached";
const REVIEW_CONTINUATION_CLAIM_PAYLOAD_KEY = "_reviewContinuationClaimed";
const REVIEW_CONTINUATION_COMPLETED_PAYLOAD_KEY = "_reviewContinuationCompleted";

export type RecordAgentPullRequestReviewEventInput = {
  agentPrId: string;
  kind: (typeof REVIEW_CONTINUATION_EVENT_KINDS)[number];
  summary: string | null;
  actorLogin: string | null;
  actorGithubId: number | null;
  actorAvatarUrl: string | null;
  payload: Record<string, unknown>;
  providerEventId: string | null;
  occurredAt: Date;
};

export type RecordAgentPullRequestReviewEventResult =
  | { disposition: "accepted"; eventId: string }
  | { disposition: "duplicate" }
  | { disposition: "limit_reached"; shouldNotify: boolean };

export function isAgentPullRequestReviewEventKind(
  kind: string,
): kind is RecordAgentPullRequestReviewEventInput["kind"] {
  return (REVIEW_CONTINUATION_EVENT_KINDS as readonly string[]).includes(kind);
}

// AgentPullRequest is the consistency boundary for the review loop. Lock it
// while recording and counting review interactions so concurrent webhook
// deliveries cannot process more than the configured per-PR safety limit.
export async function recordAgentPullRequestReviewEvent(
  database: DB,
  input: RecordAgentPullRequestReviewEventInput,
): Promise<RecordAgentPullRequestReviewEventResult> {
  return database.transaction(async (tx) => {
    const [pullRequest] = await tx
      .select({ id: schema.agentPullRequests.id })
      .from(schema.agentPullRequests)
      .where(eq(schema.agentPullRequests.id, input.agentPrId))
      .for("update");
    if (!pullRequest) return { disposition: "duplicate" };

    const [recorded] = await tx
      .insert(schema.agentPrEvents)
      .values(input)
      .onConflictDoNothing()
      .returning({ id: schema.agentPrEvents.id, payload: schema.agentPrEvents.payload });

    let claimTarget = recorded;
    if (!claimTarget && input.providerEventId) {
      const existing = await tx.query.agentPrEvents.findFirst({
        where: and(
          eq(schema.agentPrEvents.agentPrId, input.agentPrId),
          eq(schema.agentPrEvents.providerEventId, input.providerEventId),
        ),
        columns: { id: true, payload: true },
      });
      if (existing?.payload?.[REVIEW_CONTINUATION_CLAIM_PAYLOAD_KEY] === true) {
        return existing.payload[REVIEW_CONTINUATION_COMPLETED_PAYLOAD_KEY] === true
          ? { disposition: "duplicate" }
          : { disposition: "accepted", eventId: existing.id };
      }
      claimTarget = existing;
    }

    const [reviewCount] = await tx
      .select({ value: count() })
      .from(schema.agentPrEvents)
      .where(
        and(
          eq(schema.agentPrEvents.agentPrId, input.agentPrId),
          sql`${schema.agentPrEvents.payload}->>${REVIEW_CONTINUATION_CLAIM_PAYLOAD_KEY} = 'true'`,
        ),
      );
    if ((reviewCount?.value ?? 0) < AGENT_PULL_REQUEST_REVIEW_CONTINUATION_LIMIT) {
      if (!claimTarget) return { disposition: "duplicate" };
      await tx
        .update(schema.agentPrEvents)
        .set({
          payload: {
            ...(claimTarget.payload ?? input.payload),
            [REVIEW_CONTINUATION_CLAIM_PAYLOAD_KEY]: true,
          },
        })
        .where(eq(schema.agentPrEvents.id, claimTarget.id));
      return { disposition: "accepted", eventId: claimTarget.id };
    }

    const [notificationClaim] = await tx
      .insert(schema.agentPrEvents)
      .values({
        agentPrId: input.agentPrId,
        kind: REVIEW_CONTINUATION_LIMIT_EVENT_KIND,
        summary: `Stopped automatic review follow-up after ${AGENT_PULL_REQUEST_REVIEW_CONTINUATION_LIMIT} interactions.`,
        providerEventId: REVIEW_CONTINUATION_LIMIT_PROVIDER_EVENT_ID,
        occurredAt: input.occurredAt,
      })
      .onConflictDoNothing()
      .returning({ id: schema.agentPrEvents.id });
    return { disposition: "limit_reached", shouldNotify: notificationClaim !== undefined };
  });
}

export async function completeAgentPullRequestReviewContinuationClaim(
  database: DB,
  input: { agentPrId: string; eventId: string },
): Promise<void> {
  await database.transaction(async (tx) => {
    await tx
      .select({ id: schema.agentPullRequests.id })
      .from(schema.agentPullRequests)
      .where(eq(schema.agentPullRequests.id, input.agentPrId))
      .for("update");
    await tx
      .update(schema.agentPrEvents)
      .set({
        payload: sql`coalesce(${schema.agentPrEvents.payload}, '{}'::jsonb) || jsonb_build_object(${REVIEW_CONTINUATION_COMPLETED_PAYLOAD_KEY}::text, true)`,
      })
      .where(
        and(
          eq(schema.agentPrEvents.id, input.eventId),
          eq(schema.agentPrEvents.agentPrId, input.agentPrId),
        ),
      );
  });
}

export async function releaseAgentPullRequestReviewContinuationClaim(
  database: DB,
  input: { agentPrId: string; eventId: string },
): Promise<void> {
  await database.transaction(async (tx) => {
    await tx
      .select({ id: schema.agentPullRequests.id })
      .from(schema.agentPullRequests)
      .where(eq(schema.agentPullRequests.id, input.agentPrId))
      .for("update");
    await tx
      .update(schema.agentPrEvents)
      .set({
        payload: sql`${schema.agentPrEvents.payload} - ${REVIEW_CONTINUATION_CLAIM_PAYLOAD_KEY} - ${REVIEW_CONTINUATION_COMPLETED_PAYLOAD_KEY}`,
      })
      .where(
        and(
          eq(schema.agentPrEvents.id, input.eventId),
          eq(schema.agentPrEvents.agentPrId, input.agentPrId),
        ),
      );
  });
}

export async function releaseAgentPullRequestReviewLimitNotification(
  database: DB,
  agentPrId: string,
): Promise<void> {
  await database
    .delete(schema.agentPrEvents)
    .where(
      and(
        eq(schema.agentPrEvents.agentPrId, agentPrId),
        eq(schema.agentPrEvents.kind, REVIEW_CONTINUATION_LIMIT_EVENT_KIND),
        eq(schema.agentPrEvents.providerEventId, REVIEW_CONTINUATION_LIMIT_PROVIDER_EVENT_ID),
      ),
    );
}

export async function applyAgentPullRequestState(
  database: DB,
  input: ApplyAgentPullRequestStateInput,
): Promise<ApplyAgentPullRequestStateResult> {
  return database.transaction((tx) => applyAgentPullRequestStateInTx(tx, input));
}

export async function applyAgentPullRequestStateInTx(
  tx: AgentPullRequestStateTx,
  input: ApplyAgentPullRequestStateInput,
): Promise<ApplyAgentPullRequestStateResult> {
  const observedAt = input.observedAt ?? new Date();
  const [incident] = await tx
    .select({ id: schema.incidents.id })
    .from(schema.incidents)
    .where(eq(schema.incidents.id, input.incidentId))
    .orderBy(asc(schema.incidents.id))
    .for("update");
  if (!incident) {
    return {
      pullRequest: null,
      previousState: null,
      stateChanged: false,
      providerReconciliationRequired: false,
    };
  }

  const [current] = await tx
    .select()
    .from(schema.agentPullRequests)
    .where(
      and(
        eq(schema.agentPullRequests.id, input.agentPrId),
        eq(schema.agentPullRequests.incidentId, incident.id),
      ),
    )
    .for("update");
  if (!current) {
    return {
      pullRequest: null,
      previousState: null,
      stateChanged: false,
      providerReconciliationRequired: false,
    };
  }

  const isOlderProviderObservation =
    input.providerUpdatedAt !== undefined &&
    current.providerUpdatedAt !== null &&
    input.providerUpdatedAt < current.providerUpdatedAt;
  // Provider deliveries are not ordered by arrival time. Ignore an older
  // non-terminal observation wholesale so it cannot regress state,
  // metadata, or the watermark. A merge remains terminal and may supersede
  // any reversible observation, while retaining the newer watermark.
  if (input.targetState !== "merged" && isOlderProviderObservation) {
    return {
      pullRequest: current,
      previousState: current.state,
      stateChanged: false,
      providerReconciliationRequired: false,
    };
  }
  const hasAmbiguousProviderState =
    !input.providerSnapshotAuthoritative &&
    input.providerUpdatedAt !== undefined &&
    current.providerUpdatedAt !== null &&
    input.providerUpdatedAt.getTime() === current.providerUpdatedAt.getTime() &&
    input.targetState !== undefined &&
    input.targetState !== "merged" &&
    current.state !== "merged" &&
    input.targetState !== current.state;
  if (hasAmbiguousProviderState) {
    return {
      pullRequest: current,
      previousState: current.state,
      stateChanged: false,
      providerReconciliationRequired: true,
    };
  }

  const updates: Partial<typeof schema.agentPullRequests.$inferInsert> = {
    lastSyncedAt: observedAt,
    updatedAt: observedAt,
  };
  const advancesProviderOrdering =
    input.targetState !== undefined || input.providerSnapshotAuthoritative === true;
  if (
    input.providerUpdatedAt !== undefined &&
    !isOlderProviderObservation &&
    advancesProviderOrdering
  ) {
    updates.providerUpdatedAt = input.providerUpdatedAt;
  }
  if (input.headSha !== undefined) updates.headSha = input.headSha;
  if (input.title !== undefined) updates.title = input.title;

  let stateChanged = false;
  if (input.targetState === "merged") {
    // Merged is terminal and may supersede either an open or an earlier
    // unmerged close. A redelivered merge can still enrich its metadata.
    stateChanged = current.state !== "merged";
    updates.state = "merged";
    if (input.mergedAt !== undefined) updates.mergedAt = input.mergedAt;
    if (input.closedAt !== undefined) {
      updates.closedAt = input.closedAt;
    } else if (stateChanged) {
      updates.closedAt = observedAt;
    }
    if (input.mergedByLogin !== undefined) updates.mergedByLogin = input.mergedByLogin;
    if (input.mergedByGithubId !== undefined) {
      updates.mergedByGithubId = input.mergedByGithubId;
    }
  } else if (input.targetState === "closed" && current.state === "open") {
    stateChanged = true;
    updates.state = "closed";
    if (input.closedAt !== undefined) updates.closedAt = input.closedAt;
  } else if (input.targetState === "open" && current.state === "closed") {
    // A reopened delivery is meaningful only for a prior unmerged close.
    // In particular, it can never reopen a merged PR.
    stateChanged = true;
    updates.state = "open";
    updates.closedAt = null;
  }

  const [updated] = await tx
    .update(schema.agentPullRequests)
    .set(updates)
    .where(eq(schema.agentPullRequests.id, current.id))
    .returning();
  return {
    pullRequest: updated ?? current,
    previousState: current.state,
    stateChanged,
    providerReconciliationRequired: false,
  };
}
