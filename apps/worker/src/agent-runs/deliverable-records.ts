import {
  type DB,
  captureAgentPrLifecycleEvent,
  db,
  linearTicketAcceptanceUnit,
  resolveIncidentOrg,
  schema,
} from "@superlog/db";
import { and, eq } from "drizzle-orm";
import type { AgentRunContext } from "../agent-run-context.js";
import { logger } from "../logger.js";
import { recordPrCreatedMetric } from "../pr-metrics.js";

export type PullRequestDeliveryIdentity = {
  deliveryId: string;
  inputHash: string;
  requestedBranchName: string;
};

export type RecordedPullRequestDelivery = {
  repoFullName: string;
  requestedBranchName: string;
  branchName: string;
  url: string;
  prNumber: number;
  updatedExisting: boolean;
  headSha: string;
};

export type PullRequestDeliveryReceipt = {
  newlyRecorded: boolean;
  delivery: RecordedPullRequestDelivery;
};

const PULL_REQUEST_DELIVERY_EVENT_KIND = "internal_agent_outcome_pr_delivery";

export function pullRequestDeliveryReceiptKey(deliveryId: string): string {
  return `internal_agent_outcome_pr_delivery:${deliveryId}`;
}

function parseRecordedPullRequestDelivery(
  detail: Record<string, unknown> | null | undefined,
  identity: PullRequestDeliveryIdentity,
): RecordedPullRequestDelivery | null {
  if (
    !detail ||
    detail.deliveryId !== identity.deliveryId ||
    detail.inputHash !== identity.inputHash ||
    typeof detail.repoFullName !== "string" ||
    detail.requestedBranchName !== identity.requestedBranchName ||
    typeof detail.branchName !== "string" ||
    typeof detail.url !== "string" ||
    typeof detail.prNumber !== "number" ||
    typeof detail.updatedExisting !== "boolean" ||
    typeof detail.headSha !== "string"
  ) {
    return null;
  }
  return {
    repoFullName: detail.repoFullName,
    requestedBranchName: identity.requestedBranchName,
    branchName: detail.branchName,
    url: detail.url,
    prNumber: detail.prNumber,
    updatedExisting: detail.updatedExisting,
    headSha: detail.headSha,
  };
}

export async function findRecordedPullRequestDelivery(
  opts: {
    incidentId: string;
    agentRunId: string;
    identity: PullRequestDeliveryIdentity;
    repoFullName: string;
  },
  database: DB = db,
): Promise<RecordedPullRequestDelivery | null> {
  const event = await database.query.incidentEvents.findFirst({
    where: and(
      eq(schema.incidentEvents.incidentId, opts.incidentId),
      eq(schema.incidentEvents.agentRunId, opts.agentRunId),
      eq(schema.incidentEvents.kind, PULL_REQUEST_DELIVERY_EVENT_KIND),
      eq(schema.incidentEvents.dedupeKey, pullRequestDeliveryReceiptKey(opts.identity.deliveryId)),
    ),
    columns: { detail: true },
  });
  const delivery = parseRecordedPullRequestDelivery(event?.detail, opts.identity);
  if (!event) return null;
  if (!delivery || delivery.repoFullName !== opts.repoFullName) {
    throw new Error("pull request delivery receipt conflicted with different input");
  }
  return delivery;
}

type PullRequestRecordTx = Parameters<Parameters<DB["transaction"]>[0]>[0];

async function recordPullRequestDeliveryInTx(
  tx: PullRequestRecordTx,
  opts: {
    incidentId: string;
    agentRunId: string;
    identity: PullRequestDeliveryIdentity;
    delivery: RecordedPullRequestDelivery;
    now: Date;
  },
): Promise<PullRequestDeliveryReceipt> {
  const detail = {
    deliveryId: opts.identity.deliveryId,
    inputHash: opts.identity.inputHash,
    ...opts.delivery,
  };
  const inserted = await tx
    .insert(schema.incidentEvents)
    .values({
      incidentId: opts.incidentId,
      agentRunId: opts.agentRunId,
      kind: PULL_REQUEST_DELIVERY_EVENT_KIND,
      summary: null,
      detail,
      dedupeKey: pullRequestDeliveryReceiptKey(opts.identity.deliveryId),
      processedAt: opts.now,
      createdAt: opts.now,
    })
    .onConflictDoNothing()
    .returning({ id: schema.incidentEvents.id });
  if (inserted.length > 0) {
    return { newlyRecorded: true, delivery: opts.delivery };
  }

  const existing = await tx.query.incidentEvents.findFirst({
    where: and(
      eq(schema.incidentEvents.incidentId, opts.incidentId),
      eq(schema.incidentEvents.agentRunId, opts.agentRunId),
      eq(schema.incidentEvents.dedupeKey, pullRequestDeliveryReceiptKey(opts.identity.deliveryId)),
    ),
    columns: { detail: true },
  });
  const delivery = parseRecordedPullRequestDelivery(existing?.detail, opts.identity);
  if (!delivery) {
    throw new Error("pull request delivery receipt conflicted with different input");
  }
  return { newlyRecorded: false, delivery };
}

export type PullRequestMutationReconciliationDecision =
  | { kind: "deliver" }
  | {
      kind: "close_pull_request";
      reason: "incident_not_open" | "canonical_not_open";
      incidentStatus: schema.IncidentStatus | null;
      canonicalState: schema.AgentPrState | null;
    };

export function decidePullRequestMutationReconciliation(input: {
  incidentStatus: schema.IncidentStatus | null;
  canonicalState: schema.AgentPrState | null;
  deliveredState?: schema.AgentPrState;
}): PullRequestMutationReconciliationDecision {
  if (input.incidentStatus !== "open") {
    return {
      kind: "close_pull_request",
      reason: "incident_not_open",
      incidentStatus: input.incidentStatus,
      canonicalState: input.canonicalState,
    };
  }
  // recordOpenedAgentPullRequest supplies the provider's current state. When
  // this exact PR already belongs to the Incident, a state mismatch means its
  // lifecycle webhook is still converging the canonical row; compensating the
  // recovered PR would fight that transition (and cannot undo a merge).
  // Follow-up pushes omit deliveredState and retain the strict open-state gate.
  const canonicalCanConvergeFromWebhook =
    input.deliveredState !== undefined && input.canonicalState !== null;
  if (
    input.canonicalState !== (input.deliveredState ?? "open") &&
    !canonicalCanConvergeFromWebhook
  ) {
    return {
      kind: "close_pull_request",
      reason: "canonical_not_open",
      incidentStatus: input.incidentStatus,
      canonicalState: input.canonicalState,
    };
  }
  return { kind: "deliver" };
}

export type PullRequestMutationReconciliation = PullRequestMutationReconciliationDecision & {
  agentPullRequestId: string | null;
  newlyInserted: boolean;
  deliveryReceipt?: PullRequestDeliveryReceipt;
};

type PullRequestRecordDependencies = {
  database?: DB;
  now?: () => Date;
  recordCreatedMetric?: typeof recordPrCreatedMetric;
};

export async function resolveIncidentOrgBestEffort(
  resolve: () => Promise<{ id: string; name: string } | null>,
): Promise<{ id: string; name: string } | null> {
  try {
    return await resolve();
  } catch {
    return null;
  }
}

export async function recordFiledLinearTicket(
  ctx: AgentRunContext,
  ticket: schema.AgentRunLinearTicket | null | undefined,
  opts: { identifier?: string | null } = {},
): Promise<void> {
  if (!ticket?.id) return;
  if (!ctx.linearInstall) return;
  const now = new Date();
  const inserted = await db
    .insert(schema.agentLinearTickets)
    .values({
      incidentId: ctx.incident.id,
      agentRunId: ctx.agentRun.id,
      installationId: ctx.linearInstall.id,
      workspaceId: ctx.linearInstall.workspaceId,
      ticketId: ticket.id,
      ticketIdentifier: opts.identifier ?? null,
      url: ticket.url ?? null,
      lastSyncedAt: now,
    })
    .onConflictDoNothing({
      target: [schema.agentLinearTickets.workspaceId, schema.agentLinearTickets.ticketId],
    })
    .returning({ id: schema.agentLinearTickets.id });
  const row = inserted[0];
  if (!row) return;
  await db
    .insert(schema.agentLinearTicketEvents)
    .values({
      agentLinearTicketId: row.id,
      kind: "ticket_filed",
      summary: `Filed Linear ticket ${opts.identifier ?? ticket.id}`,
      payload: { url: ticket.url ?? null, createdByAgent: ticket.createdByAgent },
      providerEventId: `ticket_filed:${ctx.linearInstall.workspaceId}:${ticket.id}`,
      occurredAt: now,
    })
    .onConflictDoNothing();

  // Findings-only investigations still belong in the PR-acceptance funnel.
  // When this run has no PR, the durable ticket row is its stable acceptance
  // unit and this newly-inserted path emits the denominator exactly once.
  const pr = await db.query.agentPullRequests.findFirst({
    where: eq(schema.agentPullRequests.agentRunId, ctx.agentRun.id),
    columns: { id: true },
  });
  if (!pr) {
    const org = await resolveIncidentOrgBestEffort(() => resolveIncidentOrg(ctx.incident.id));
    captureAgentPrLifecycleEvent({
      kind: "opened",
      pr: linearTicketAcceptanceUnit({
        id: row.id,
        incidentId: ctx.incident.id,
        agentRunId: ctx.agentRun.id,
        url: ticket.url ?? null,
      }),
      org,
    });
  }
}

export async function recordOpenedAgentPullRequest(
  opts: {
    incidentId: string;
    agentRunId: string;
    installationRowId: string;
    repoFullName: string;
    prNumber: number;
    prNodeId: string;
    url: string;
    branchName: string;
    baseBranch: string;
    headSha: string;
    title: string;
    authorLogin: string | null;
    authorGithubId: number | null;
    authorAvatarUrl: string | null;
    state: schema.AgentPrState;
    mergedAt: Date | null;
    deliveryIdentity?: PullRequestDeliveryIdentity;
  },
  deps: PullRequestRecordDependencies = {},
): Promise<PullRequestMutationReconciliation> {
  const database = deps.database ?? db;
  const now = (deps.now ?? (() => new Date()))();
  const reconciliation = await database.transaction(async (tx) => {
    // This is the same row-level serialization boundary used by incident
    // resolution. Whichever transaction gets the Incident lock first decides
    // whether the GitHub mutation may remain delivered.
    const incidents = await tx
      .select({ status: schema.incidents.status })
      .from(schema.incidents)
      .where(eq(schema.incidents.id, opts.incidentId))
      .for("update");
    const incidentStatus = incidents[0]?.status ?? null;
    if (incidentStatus === null) {
      const decision = decidePullRequestMutationReconciliation({
        incidentStatus,
        canonicalState: null,
      });
      return { ...decision, agentPullRequestId: null, newlyInserted: false };
    }

    const inserted = await tx
      .insert(schema.agentPullRequests)
      .values({
        incidentId: opts.incidentId,
        agentRunId: opts.agentRunId,
        installationId: opts.installationRowId,
        repoFullName: opts.repoFullName,
        prNumber: opts.prNumber,
        prNodeId: opts.prNodeId,
        url: opts.url,
        branchName: opts.branchName,
        baseBranch: opts.baseBranch,
        headSha: opts.headSha,
        state: opts.state,
        title: opts.title,
        mergedAt: opts.mergedAt,
        lastSyncedAt: now,
      })
      .onConflictDoNothing({
        target: [schema.agentPullRequests.repoFullName, schema.agentPullRequests.prNumber],
      })
      .returning({
        id: schema.agentPullRequests.id,
        incidentId: schema.agentPullRequests.incidentId,
        state: schema.agentPullRequests.state,
      });
    const row =
      inserted[0] ??
      (await tx.query.agentPullRequests.findFirst({
        where: and(
          eq(schema.agentPullRequests.repoFullName, opts.repoFullName),
          eq(schema.agentPullRequests.prNumber, opts.prNumber),
        ),
        columns: { id: true, incidentId: true, state: true },
      }));
    const canonicalState = row?.incidentId === opts.incidentId ? row.state : null;
    const decision = decidePullRequestMutationReconciliation({
      incidentStatus,
      canonicalState,
      deliveredState: opts.state,
    });

    if (inserted[0] && row) {
      await tx
        .insert(schema.agentPrEvents)
        .values({
          agentPrId: row.id,
          kind: "pr_opened",
          summary: `Opened PR #${opts.prNumber}`,
          actorLogin: opts.authorLogin,
          actorGithubId: opts.authorGithubId,
          actorAvatarUrl: opts.authorAvatarUrl,
          payload: {
            url: opts.url,
            branch: opts.branchName,
            base: opts.baseBranch,
            headSha: opts.headSha,
          },
          providerEventId: `pr_opened:${opts.repoFullName}#${opts.prNumber}`,
          occurredAt: now,
        })
        .onConflictDoNothing();
    }
    const deliveryReceipt =
      decision.kind === "deliver" && row && opts.deliveryIdentity
        ? await recordPullRequestDeliveryInTx(tx, {
            incidentId: opts.incidentId,
            agentRunId: opts.agentRunId,
            identity: opts.deliveryIdentity,
            delivery: {
              repoFullName: opts.repoFullName,
              requestedBranchName: opts.deliveryIdentity.requestedBranchName,
              branchName: opts.branchName,
              url: opts.url,
              prNumber: opts.prNumber,
              updatedExisting: false,
              headSha: opts.headSha,
            },
            now,
          })
        : undefined;
    return {
      ...decision,
      agentPullRequestId: row?.id ?? null,
      newlyInserted: inserted.length > 0,
      ...(deliveryReceipt ? { deliveryReceipt } : {}),
    };
  });

  if (!reconciliation.newlyInserted || !reconciliation.agentPullRequestId) {
    return reconciliation;
  }
  // Only reached when the PR row was newly inserted (see `if (!row) return`
  // above), so retries / re-deliveries don't double-count.
  await (deps.recordCreatedMetric ?? recordPrCreatedMetric)({
    id: reconciliation.agentPullRequestId,
    incidentId: opts.incidentId,
    agentRunId: opts.agentRunId,
    repoFullName: opts.repoFullName,
    prNumber: opts.prNumber,
    url: opts.url,
  }).catch((err) =>
    logger.warn(
      {
        err,
        agentRunId: opts.agentRunId,
        repoFullName: opts.repoFullName,
        prNumber: opts.prNumber,
      },
      "failed to record PR-created metric after canonical delivery committed",
    ),
  );
  return reconciliation;
}

export async function recordUpdatedAgentPullRequest(
  opts: {
    incidentId: string;
    agentRunId?: string;
    agentPullRequestId: string;
    repoFullName: string;
    prNumber: number;
    headSha: string;
    url?: string;
    branchName?: string;
    deliveryIdentity?: PullRequestDeliveryIdentity;
  },
  deps: Pick<PullRequestRecordDependencies, "database" | "now"> = {},
): Promise<PullRequestMutationReconciliation> {
  const database = deps.database ?? db;
  const now = (deps.now ?? (() => new Date()))();
  return database.transaction(async (tx) => {
    const incidents = await tx
      .select({ status: schema.incidents.status })
      .from(schema.incidents)
      .where(eq(schema.incidents.id, opts.incidentId))
      .for("update");
    const incidentStatus = incidents[0]?.status ?? null;
    if (incidentStatus === null) {
      const decision = decidePullRequestMutationReconciliation({
        incidentStatus,
        canonicalState: null,
      });
      return { ...decision, agentPullRequestId: null, newlyInserted: false };
    }

    const updated = await tx
      .update(schema.agentPullRequests)
      .set({ headSha: opts.headSha, lastSyncedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.agentPullRequests.id, opts.agentPullRequestId),
          eq(schema.agentPullRequests.incidentId, opts.incidentId),
          eq(schema.agentPullRequests.repoFullName, opts.repoFullName),
          eq(schema.agentPullRequests.prNumber, opts.prNumber),
          eq(schema.agentPullRequests.state, "open"),
        ),
      )
      .returning({
        id: schema.agentPullRequests.id,
        incidentId: schema.agentPullRequests.incidentId,
        state: schema.agentPullRequests.state,
      });
    const row =
      updated[0] ??
      (await tx.query.agentPullRequests.findFirst({
        where: and(
          eq(schema.agentPullRequests.id, opts.agentPullRequestId),
          eq(schema.agentPullRequests.repoFullName, opts.repoFullName),
          eq(schema.agentPullRequests.prNumber, opts.prNumber),
        ),
        columns: { id: true, incidentId: true, state: true },
      }));
    const canonicalState = row?.incidentId === opts.incidentId ? row.state : null;
    const decision = decidePullRequestMutationReconciliation({
      incidentStatus,
      canonicalState,
    });
    let deliveryReceipt: PullRequestDeliveryReceipt | undefined;
    if (decision.kind === "deliver" && opts.deliveryIdentity) {
      if (!opts.agentRunId || !opts.url || !opts.branchName) {
        throw new Error("existing PR delivery receipt requires run, URL, and branch coordinates");
      }
      deliveryReceipt = await recordPullRequestDeliveryInTx(tx, {
        incidentId: opts.incidentId,
        agentRunId: opts.agentRunId,
        identity: opts.deliveryIdentity,
        delivery: {
          repoFullName: opts.repoFullName,
          requestedBranchName: opts.deliveryIdentity.requestedBranchName,
          branchName: opts.branchName,
          url: opts.url,
          prNumber: opts.prNumber,
          updatedExisting: true,
          headSha: opts.headSha,
        },
        now,
      });
    }
    return {
      ...decision,
      agentPullRequestId: row?.id ?? null,
      newlyInserted: false,
      ...(deliveryReceipt ? { deliveryReceipt } : {}),
    };
  });
}

export type MarkAgentPullRequestClosedResult =
  | { canonicalRecordFound: false; canonicalState: null }
  | { canonicalRecordFound: true; canonicalState: schema.AgentPrState };

export async function markAgentPullRequestClosedAfterDeliveryAbort(
  opts: {
    repoFullName: string;
    prNumber: number;
    reason: "incident_not_open" | "reconciliation_failed";
  },
  deps: Pick<PullRequestRecordDependencies, "database" | "now"> = {},
): Promise<MarkAgentPullRequestClosedResult> {
  const database = deps.database ?? db;
  const now = (deps.now ?? (() => new Date()))();
  return database.transaction(async (tx) => {
    const row = await tx.query.agentPullRequests.findFirst({
      where: and(
        eq(schema.agentPullRequests.repoFullName, opts.repoFullName),
        eq(schema.agentPullRequests.prNumber, opts.prNumber),
      ),
      columns: { id: true, state: true },
    });
    if (!row) return { canonicalRecordFound: false, canonicalState: null };
    if (row.state !== "open") {
      return { canonicalRecordFound: true, canonicalState: row.state };
    }

    const updated = await tx
      .update(schema.agentPullRequests)
      .set({ state: "closed", closedAt: now, lastSyncedAt: now, updatedAt: now })
      .where(
        and(eq(schema.agentPullRequests.id, row.id), eq(schema.agentPullRequests.state, "open")),
      )
      .returning({ id: schema.agentPullRequests.id, state: schema.agentPullRequests.state });
    const closed = updated[0];
    if (!closed) {
      const refreshed = await tx.query.agentPullRequests.findFirst({
        where: eq(schema.agentPullRequests.id, row.id),
        columns: { state: true },
      });
      return refreshed
        ? { canonicalRecordFound: true, canonicalState: refreshed.state }
        : { canonicalRecordFound: false, canonicalState: null };
    }

    await tx
      .insert(schema.agentPrEvents)
      .values({
        agentPrId: row.id,
        kind: "pr_closed",
        summary:
          opts.reason === "incident_not_open"
            ? `Closed PR #${opts.prNumber} because incident resolution won delivery reconciliation.`
            : `Closed PR #${opts.prNumber} after delivery reconciliation failed.`,
        payload: {
          repoFullName: opts.repoFullName,
          prNumber: opts.prNumber,
          deliveryAbortReason: opts.reason,
        },
        providerEventId: `pr_closed:delivery_abort:${opts.reason}:${row.id}`,
        occurredAt: now,
      })
      .onConflictDoNothing();
    return { canonicalRecordFound: true, canonicalState: closed.state };
  });
}
