import { and, eq, isNull } from "drizzle-orm";
import { type DB, db } from "./client.js";
import { generateCodename } from "./codename.js";
import { type Tx, createIncidentRepository } from "./incident-repository.js";
import {
  assertIncidentSourceState,
  buildAgentRunIncidentPatch,
  buildManualReopenPatch,
  buildRegressionReopenPatch,
  decideRegressionTransition,
} from "./incident-state.js";
import * as schema from "./schema.js";
import {
  type IncidentReopenedReason,
  enqueueIncidentReopened,
  enqueueIncidentResolved,
} from "./webhook-events.js";

// Outbound webhooks are a best-effort side effect of a committed lifecycle
// transition: a delivery row is written after the transaction succeeds, and a
// failure to enqueue must never roll back or throw out of the resolve/reopen.
// The worker's delivery loop is the durable retry path once a row exists.
async function emitIncidentResolved(database: DB, incidentId: string): Promise<void> {
  try {
    await enqueueIncidentResolved(incidentId, database);
  } catch (err) {
    console.error("failed to enqueue incident.resolved webhook", { incidentId, err });
  }
}

async function emitIncidentReopened(
  database: DB,
  incidentId: string,
  opts: { reason: IncidentReopenedReason; previousStatus: string | null },
): Promise<void> {
  try {
    await enqueueIncidentReopened(incidentId, opts, database);
  } catch (err) {
    console.error("failed to enqueue incident.reopened webhook", { incidentId, err });
  }
}

export type ResolveIncidentInput = {
  incidentId: string;
  // Discriminator describing who or what flipped the incident closed.
  kind: schema.IncidentResolvedByKind;
  // Short code describing the resolution (e.g. `fixed_in_current_code`,
  // `agent_pr_merged`, `slack_manual`, `external_dependency_recovered`).
  // Stored verbatim on the incident; used for filtering in the dashboard.
  reasonCode: string;
  // Human-readable evidence (agent-written for classification/sweep paths,
  // PR title for the merge path, optional note for manual).
  reasonText: string | null;
  // App user (Better Auth `users.id`) when the resolve came from a logged-in
  // dashboard action — currently unused but reserved.
  resolvedByUserId?: string | null;
  // Slack user id (`U…`) when the resolve came from a Slack button click.
  resolvedBySlackUserId?: string | null;
  // When set, the emitted `incident_resolved` event is also tied to this
  // agent run (so it shows up alongside the run's own activity). When
  // null, the event is purely incident-scoped — still surfaces in the
  // dashboard timeline via the incident_id column.
  agentRunId?: string | null;
  // Structured detail to stash on the incident event (PR metadata, etc).
  eventDetail?: Record<string, unknown>;
  // Stable dedupe key for the incident event — prevents duplicate
  // resolve rows when a webhook or worker retries.
  eventDedupeKey?: string;
  // Human/agent-readable summary for the incident event.
  eventSummary?: string;
  // Override the "resolved at" timestamp (e.g. use GitHub's `merged_at`
  // instead of now()). Defaults to new Date().
  resolvedAt?: Date;
  // Set when the resolver wants to suppress auto-investigation re-runs for
  // a window (used by `fixed_in_current_code` to wait out the deploy).
  // Other resolvers leave it null and the helper actively clears any prior
  // cooldown so a recurrence triggers a fresh investigation.
  autoInvestigateSuppressedUntil?: Date | null;
};

export type ResolveIncidentResult = {
  // True iff the UPDATE matched a row in `open` status — i.e. this call was
  // the one that actually resolved the incident. False means somebody else
  // (race, repeat webhook, etc.) already closed it.
  resolved: boolean;
  // How many linked issues were also marked resolved.
  resolvedIssueCount: number;
};

export type ApplyAgentRunResultOutcome = {
  updated: boolean;
  noiseResolved: boolean;
};

export type ReopenIncidentResult = {
  reopened: boolean;
  stayedNoise: boolean;
};

export async function mergeIncidentsInTx(
  tx: Tx,
  opts: {
    sourceIncident: schema.Incident;
    targetIncident: schema.Incident;
    mergedAt?: Date;
  },
): Promise<void> {
  assertIncidentSourceState("mergeIncidentsInTx", opts.sourceIncident.status, ["open"]);
  assertIncidentSourceState("mergeIncidentsInTx", opts.targetIncident.status, ["open"]);
  const now = opts.mergedAt ?? new Date();
  await createIncidentRepository(db).mergeOpenIncidentsInTx(tx, { ...opts, mergedAt: now });
}

export type IncidentLifecycle = ReturnType<typeof createIncidentLifecycle>;

export type CreateOpenIncidentOpts = {
  projectId: string;
  service: string | null;
  environment?: string | null;
  title: string;
  firstSeen: Date;
  lastSeen: Date;
};

// Single source of truth for opening an incident: the Postgres unique index on
// (project_id, codename) protects against races, so retry a handful of random
// codenames. Each attempt runs in a savepoint (nested transaction) so a
// collision rolls back just that insert — not the caller's transaction.
async function allocateOpenIncidentInTx(
  tx: Tx,
  opts: CreateOpenIncidentOpts,
): Promise<schema.Incident> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const codename = generateCodename();
    try {
      const created = await tx.transaction((sp) =>
        sp
          .insert(schema.incidents)
          .values({
            projectId: opts.projectId,
            service: opts.service,
            environment: opts.environment ?? null,
            title: opts.title,
            codename,
            status: "open",
            firstSeen: opts.firstSeen,
            lastSeen: opts.lastSeen,
            issueCount: 0,
          })
          .returning(),
      );
      if (created[0]) return created[0];
    } catch (err) {
      // drizzle-orm wraps postgres errors in DrizzleQueryError; the original
      // postgres error (with its .code) is stored on .cause. 23505 =
      // unique_violation; anything else is a real failure.
      const anyErr = err as { code?: string; cause?: { code?: string } } | null;
      if ((anyErr?.code ?? anyErr?.cause?.code) !== "23505") throw err;
    }
  }
  throw new Error("failed to allocate a unique incident codename after 6 attempts");
}

export function createIncidentLifecycle(database: DB = db) {
  const repository = createIncidentRepository(database);

  return {
    // Open an incident in its own transaction.
    async createOpen(opts: CreateOpenIncidentOpts): Promise<schema.Incident> {
      return database.transaction((tx) => allocateOpenIncidentInTx(tx, opts));
    },

    // Same allocation, but joins a caller's transaction so the incident and
    // whatever else the caller writes (e.g. an initial agent run) commit
    // atomically — no orphan incident on partial failure.
    createOpenInTx(tx: Tx, opts: CreateOpenIncidentOpts): Promise<schema.Incident> {
      return allocateOpenIncidentInTx(tx, opts);
    },

    async resolve(input: ResolveIncidentInput): Promise<ResolveIncidentResult> {
      const result = await repository.transaction((tx) =>
        resolveIncidentInTx(tx, input, repository),
      );
      if (result.resolved) await emitIncidentResolved(database, input.incidentId);
      return result;
    },

    async applyAgentRunResult(opts: {
      incident: schema.Incident;
      agentRunId: string;
      result: schema.AgentRunResult;
      titleMaxLength?: number;
    }): Promise<ApplyAgentRunResultOutcome> {
      const result = opts.result;
      const { updates, noiseReason, noiseResolved } = buildAgentRunIncidentPatch(opts);

      if (Object.keys(updates).length === 0) {
        return { updated: false, noiseResolved: false };
      }

      await repository.transaction(async (tx) => {
        await repository.updateIncidentInTx(tx, opts.incident.id, updates, new Date());

        if (noiseReason) {
          await repository.insertEventInTx(tx, {
            incidentId: opts.incident.id,
            agentRunId: opts.agentRunId,
            kind: "incident_noise_classified",
            summary: "Incident marked as noise by agent run.",
            detail: {
              reason: noiseReason,
              evidence: result.noiseClassification?.evidence ?? null,
            },
            dedupeKey: `incident_noise:${opts.agentRunId}:${noiseReason}`,
          });
        }
      });

      // A noise auto-close is a terminal resolve from the consumer's POV
      // (status flips to autoresolved_noise) — emit incident.resolved so the
      // webhook taxonomy covers every path that closes an incident.
      if (noiseResolved) await emitIncidentResolved(database, opts.incident.id);

      return { updated: true, noiseResolved };
    },

    async reopenFromIssueRegression(opts: {
      incident: schema.Incident;
      issue: schema.Issue;
      latestAgentRunId?: string | null;
    }): Promise<ReopenIncidentResult> {
      const decision = decideRegressionTransition(opts.incident.status);
      if (decision.kind === "touch_active" || decision.kind === "stay_noise") {
        await repository.updateIncident(opts.incident.id, {
          status: decision.status,
          lastSeen: opts.issue.lastSeen,
        });
        return { reopened: false, stayedNoise: decision.kind === "stay_noise" };
      }

      await repository.transaction(async (tx) => {
        const now = new Date();
        let latestAgentRunId = opts.latestAgentRunId ?? null;
        if (opts.latestAgentRunId === undefined) {
          const latestAgentRun = await repository.findLatestAgentRunIdInTx(tx, opts.incident.id);
          latestAgentRunId = latestAgentRun?.id ?? null;
        }
        await repository.updateIncidentInTx(
          tx,
          opts.incident.id,
          buildRegressionReopenPatch(opts.issue),
          now,
        );

        await repository.insertEventInTx(tx, {
          agentRunId: latestAgentRunId,
          incidentId: opts.incident.id,
          kind: "incident_reopened",
          summary: `Incident reopened because linked issue regressed: ${opts.issue.title}`,
          detail: {
            reason: "issue_regressed",
            issueId: opts.issue.id,
            issueTitle: opts.issue.title,
            previousIncidentStatus: opts.incident.status,
          },
          dedupeKey: `incident_reopened:issue:${opts.issue.id}:${opts.issue.lastSeen.getTime()}`,
          processedAt: now,
        });
      });

      await emitIncidentReopened(database, opts.incident.id, {
        reason: "issue_regressed",
        previousStatus: opts.incident.status,
      });
      return { reopened: true, stayedNoise: false };
    },

    async reopenManually(opts: {
      incident: schema.Incident;
      actor: { userId?: string | null; slackUserId?: string | null };
      summary?: string;
      detail?: Record<string, unknown>;
      reopenedAt?: Date;
    }): Promise<{ reopened: boolean }> {
      if (opts.incident.status === "open") return { reopened: false };
      assertIncidentSourceState("reopenManually", opts.incident.status, [
        "resolved",
        "autoresolved_noise",
        "merged",
      ]);
      const now = opts.reopenedAt ?? new Date();
      await repository.transaction(async (tx) => {
        await repository.updateIncidentInTx(tx, opts.incident.id, buildManualReopenPatch(), now);
        await repository.insertEventInTx(tx, {
          incidentId: opts.incident.id,
          kind: "incident_reopened",
          summary: opts.summary ?? "Incident reopened manually.",
          detail: {
            reason: "manual",
            reopenedByUserId: opts.actor.userId ?? null,
            reopenedBySlackUserId: opts.actor.slackUserId ?? null,
            previousIncidentStatus: opts.incident.status,
            ...opts.detail,
          },
          dedupeKey: `incident_reopened:manual:${opts.incident.id}:${now.getTime()}`,
          processedAt: now,
        });
      });
      await emitIncidentReopened(database, opts.incident.id, {
        reason: "manual",
        previousStatus: opts.incident.status,
      });
      return { reopened: true };
    },
  };
}

// Single entry point for moving an incident from `open` to `resolved` and
// cascading the side effects every resolve path needs: mark linked issues
// resolved, write structured resolution columns, emit an incident
// event tied to an agent run when one is supplied.
//
// All resolve paths (PR merge, agent classification, Slack manual, sweep
// proposal confirmed) call this. Keeps the resolved_* columns honest and
// makes "why did this close" a single SQL query.
//
// The UPDATE filters on `status='open'` so it's safe to call from
// concurrent webhooks; the second caller gets `resolved: false` and skips
// the cascade.
export async function resolveIncident(input: ResolveIncidentInput): Promise<ResolveIncidentResult> {
  return createIncidentLifecycle(db).resolve(input);
}

// Body of the resolve operation, parameterised on a transaction handle.
// Exposed so callers that need to atomically combine the resolve with
// other mutations (e.g. confirming a proposal in a single transaction)
// can pass their own tx and share commit/rollback semantics.
async function resolveIncidentInTx(
  tx: Tx,
  input: ResolveIncidentInput,
  repository = createIncidentRepository(db),
): Promise<ResolveIncidentResult> {
  const resolvedAt = input.resolvedAt ?? new Date();
  const didResolve = await repository.resolveOpenIncidentInTx(tx, {
    incidentId: input.incidentId,
    resolvedAt,
    kind: input.kind,
    reasonCode: input.reasonCode,
    reasonText: input.reasonText,
    resolvedByUserId: input.resolvedByUserId,
    resolvedBySlackUserId: input.resolvedBySlackUserId,
    autoInvestigateSuppressedUntil: input.autoInvestigateSuppressedUntil,
  });
  if (!didResolve) return { resolved: false, resolvedIssueCount: 0 };

  const links = await repository.listIncidentIssueLinksInTx(tx, input.incidentId);
  const resolvedIssueCount = links.length;

  // Always emit an incident_resolved event keyed on incident_id so the
  // dashboard timeline can render it for every resolve path (PR merge,
  // agent classification, Slack manual, dashboard manual, autorecovery
  // confirmed). agent_run_id rides along when the caller has one — that
  // pairs the event with the run's activity in the timeline.
  await repository.insertEventInTx(tx, {
    agentRunId: input.agentRunId ?? null,
    incidentId: input.incidentId,
    kind: "incident_resolved",
    summary: input.eventSummary ?? `Incident resolved (${input.kind}).`,
    detail: {
      kind: input.kind,
      reasonCode: input.reasonCode,
      reasonText: input.reasonText,
      resolvedIssueCount,
      resolvedByUserId: input.resolvedByUserId ?? null,
      resolvedBySlackUserId: input.resolvedBySlackUserId ?? null,
      ...input.eventDetail,
    },
    dedupeKey:
      input.eventDedupeKey ??
      `incident_resolved:${input.kind}:${input.incidentId}:${resolvedAt.getTime()}`,
    processedAt: resolvedAt,
  });

  return { resolved: true, resolvedIssueCount };
}

export type ReopenIncidentInput = {
  incidentId: string;
  lastSeen: Date;
};

// Counterpart to resolveIncident: when a previously-resolved incident sees a
// recurring event, flip it back to `open` and null out all the resolution
// columns so the next resolve writes fresh truth. The caller is responsible
// for any side effects (events, Slack updates) — this is the DB-side cleanup.
export async function clearIncidentResolution(input: ReopenIncidentInput): Promise<void> {
  await db
    .update(schema.incidents)
    .set({
      status: "open",
      lastSeen: input.lastSeen,
      resolvedAt: null,
      resolvedByKind: null,
      resolvedByUserId: null,
      resolvedBySlackUserId: null,
      resolvedReasonCode: null,
      resolvedReasonText: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.incidents.id, input.incidentId));
}

// State machine for sweep-agent resolution proposals. Lives in the db
// package so both apps/api (Slack interactivity handler) and apps/worker
// (sweep agent) can call it.
//
// Confirm: marks the proposal `confirmed`, then resolves the incident via
// resolveIncident() with the proposal's reasonCode/reasonText. Idempotent
// against repeat clicks — second click sees `decision` already set and
// returns `already_confirmed`. The incident resolve itself is also
// race-safe (its UPDATE filters on `status='open'`).
//
// Dismiss: just marks the proposal `dismissed`. The sweep selector queries
// this row to enforce the dismissal cooldown so a teammate who clicks
// dismiss doesn't get re-pinged for the same incident in the next sweep.
// Discriminated actor input: a Slack button click carries a Slack user id;
// a dashboard click carries a Better Auth user id. Exactly one path is
// expected at a time, but both are optional so the helper stays callable
// from a system context (cron-driven auto-confirm in the future, etc.).
export type ResolutionProposalActor = {
  // Source-of-truth dashboard user id when the click came from the web app.
  userId?: string | null;
  // Slack user id when the click came from an interactivity payload.
  slackUserId?: string | null;
  // Optional display name to weave into the reason text. The Slack handler
  // passes `payload.user.name`; the dashboard handler can pass the user's
  // email or display name from `users.name`.
  displayName?: string | null;
};

function attributionPhrase(actor: ResolutionProposalActor): string {
  if (actor.userId) {
    return `Confirmed in the dashboard by ${actor.displayName ?? actor.userId}.`;
  }
  if (actor.slackUserId) {
    return `Confirmed in Slack by ${actor.displayName ?? actor.slackUserId}.`;
  }
  return "Confirmed.";
}

export async function confirmResolutionProposal(opts: {
  proposalId: string;
  actor: ResolutionProposalActor;
}): Promise<{ ok: boolean; reason?: string; incidentId?: string }> {
  // Wrap the proposal flip + the incident resolve in one transaction so
  // we can't end up with a "confirmed" proposal whose incident is still
  // open (would happen if resolveIncident throws between the two writes).
  // The proposal UPDATE is conditional on `decision IS NULL` so two
  // concurrent confirm clicks can't both succeed — second caller's
  // .returning() comes back empty and we bail before resolving.
  const outcome = await db.transaction(async (tx) => {
    const decidedAt = new Date();
    const updated = await tx
      .update(schema.incidentResolutionProposals)
      .set({
        decision: "confirmed",
        decidedAt,
        decidedByUserId: opts.actor.userId ?? null,
        decidedBySlackUserId: opts.actor.slackUserId ?? null,
      })
      .where(
        and(
          eq(schema.incidentResolutionProposals.id, opts.proposalId),
          isNull(schema.incidentResolutionProposals.decision),
        ),
      )
      .returning({
        incidentId: schema.incidentResolutionProposals.incidentId,
        proposedReasonCode: schema.incidentResolutionProposals.proposedReasonCode,
        proposedReasonText: schema.incidentResolutionProposals.proposedReasonText,
      });
    const row = updated[0];
    if (!row) {
      // Either the proposal doesn't exist or it's already decided. The
      // dashboard / Slack handler turns this into a 409 + UI refresh.
      // Distinguish unknown vs already-decided with a follow-up read so
      // the caller can render a sensible message.
      const existing = await tx.query.incidentResolutionProposals.findFirst({
        where: eq(schema.incidentResolutionProposals.id, opts.proposalId),
        columns: { decision: true },
      });
      if (!existing) return { ok: false, reason: "unknown_proposal" };
      return { ok: false, reason: `already_${existing.decision}` };
    }
    await resolveIncidentInTx(
      tx,
      {
        incidentId: row.incidentId,
        kind: "autorecovery_confirmed",
        reasonCode: row.proposedReasonCode,
        reasonText: `${row.proposedReasonText} (${attributionPhrase(opts.actor)})`,
        resolvedByUserId: opts.actor.userId ?? null,
        resolvedBySlackUserId: opts.actor.slackUserId ?? null,
        resolvedAt: decidedAt,
      },
      createIncidentRepository(db),
    );
    return { ok: true, incidentId: row.incidentId };
  });
  if (outcome.ok && outcome.incidentId) await emitIncidentResolved(db, outcome.incidentId);
  return outcome;
}

export async function dismissResolutionProposal(opts: {
  proposalId: string;
  actor: ResolutionProposalActor;
}): Promise<{ ok: boolean; reason?: string; incidentId?: string }> {
  // Conditional UPDATE — see confirmResolutionProposal for the race
  // semantics. Dismiss has no follow-on incident write so it doesn't
  // need a transaction; the atomic UPDATE is sufficient.
  const updated = await db
    .update(schema.incidentResolutionProposals)
    .set({
      decision: "dismissed",
      decidedAt: new Date(),
      decidedByUserId: opts.actor.userId ?? null,
      decidedBySlackUserId: opts.actor.slackUserId ?? null,
    })
    .where(
      and(
        eq(schema.incidentResolutionProposals.id, opts.proposalId),
        isNull(schema.incidentResolutionProposals.decision),
      ),
    )
    .returning({ incidentId: schema.incidentResolutionProposals.incidentId });
  const row = updated[0];
  if (!row) {
    const existing = await db.query.incidentResolutionProposals.findFirst({
      where: eq(schema.incidentResolutionProposals.id, opts.proposalId),
      columns: { decision: true },
    });
    if (!existing) return { ok: false, reason: "unknown_proposal" };
    return { ok: false, reason: `already_${existing.decision}` };
  }
  return { ok: true, incidentId: row.incidentId };
}
