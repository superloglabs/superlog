import { and, eq, isNull } from "drizzle-orm";
import { type DB, db } from "./client.js";
import { generateCodename } from "./codename.js";
import { type Tx, createIncidentRepository } from "./incident-repository.js";
import {
  assertIncidentSourceState,
  buildAgentRunIncidentPatch,
  buildManualReopenPatch,
} from "./incident-state.js";
import { validateCompleteIncidentIssueOutcomes } from "./issue-classification.js";
import {
  buildIssueObservePatch,
  buildIssueReopenPatch,
  buildIssueResolvePatch,
  buildIssueSilencePatch,
} from "./issue-state.js";
import * as schema from "./schema.js";
import {
  type IncidentReopenedReason,
  enqueueIncidentCreated,
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

// What happens to the incident's issues when the incident resolves. Every
// resolve carries one of these; the default is "resolve" (the "Problem
// resolved" semantics — the underlying error signature is considered fixed and
// will open a fresh incident if it recurs).
export type ResolveIssueOutcome =
  | { kind: "resolve" }
  // "Not an issue": the signature is noise; suppress future occurrences.
  | { kind: "silence" }
  // Noise, but worth watching: suppress until the escalation trigger trips.
  | { kind: "observe"; trigger: schema.IssueEscalationTrigger }
  // Caller manages issue state itself (e.g. a merge, where the surviving
  // incident keeps the issues live).
  | { kind: "none" };

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
  // Disposition applied to the incident's current issues. Defaults to
  // { kind: "resolve" }.
  issueOutcome?: ResolveIssueOutcome;
  // Agent terminal contract: exactly one independently chosen disposition
  // for every current issue. Mutually exclusive with issueOutcome.
  issueOutcomes?: schema.AgentRunIssueClassification[];
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

export type LinkIssueToOpenIncidentResult = "linked" | "already_linked" | "incident_closed";

export async function validateIncidentIssueOutcomes(
  database: DB,
  incidentId: string,
  outcomes: schema.AgentRunIssueClassification[],
): Promise<ReturnType<typeof validateCompleteIncidentIssueOutcomes>> {
  const repository = createIncidentRepository(database);
  const issues = await repository.transaction((tx) =>
    repository.listCurrentIssuesForIncidentInTx(tx, incidentId),
  );
  return validateCompleteIncidentIssueOutcomes(issues, outcomes);
}

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

    // Linking and resolving both take the Incident row lock before inspecting
    // its Issue set. Whichever lifecycle transition wins is therefore
    // definitive: a winning link is visible to resolution validation, while a
    // winning resolution prevents the late Issue from joining a closed
    // aggregate.
    async linkIssueToOpenIncident(opts: {
      incidentId: string;
      issue: Pick<schema.Issue, "id" | "lastSeen" | "service">;
    }): Promise<LinkIssueToOpenIncidentResult> {
      return repository.transaction(async (tx) => {
        const incident = await repository.lockOpenIncidentInTx(tx, opts.incidentId);
        if (!incident) return "incident_closed";
        const linked = await repository.linkIssueInTx(tx, incident, opts.issue, new Date());
        return linked ? "linked" : "already_linked";
      });
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

    // A resolved issue recurred, an under-observation issue's escalation
    // trigger fired, or an alert whose previous incident is closed breached
    // again: open a NEW incident chained to the predecessor, put the issue
    // back to `open`, and append a fresh incident_issues link (the issue's
    // link history is how "current incident" is derived). The old incident
    // keeps its findings and stays closed — its timeline records where the
    // story continued.
    async openRecurrence(opts: {
      previousIncident: schema.Incident;
      issue: schema.Issue;
      origin: "resolved_issue_recurred" | "escalation_trigger" | "alert_breached_again";
      environment?: string | null;
      now?: Date;
    }): Promise<schema.Incident> {
      const now = opts.now ?? new Date();
      const created = await repository.transaction(async (tx) => {
        const incident = await allocateOpenIncidentInTx(tx, {
          projectId: opts.issue.projectId,
          service: opts.issue.service ?? opts.previousIncident.service,
          environment: opts.environment ?? opts.previousIncident.environment,
          title: opts.issue.title,
          firstSeen: opts.issue.lastSeen,
          lastSeen: opts.issue.lastSeen,
        });
        await repository.updateIncidentInTx(
          tx,
          incident.id,
          { previousIncidentId: opts.previousIncident.id, issueCount: 1 },
          now,
        );
        await repository.updateIssueInTx(tx, opts.issue.id, buildIssueReopenPatch());
        await tx
          .insert(schema.incidentIssues)
          .values({ incidentId: incident.id, issueId: opts.issue.id })
          .onConflictDoNothing();

        await repository.insertEventInTx(tx, {
          incidentId: incident.id,
          kind: "incident_opened_from_recurrence",
          summary:
            opts.origin === "escalation_trigger"
              ? `Escalation trigger fired for observed issue: ${opts.issue.title}`
              : opts.origin === "alert_breached_again"
                ? `Alert breached again: ${opts.issue.title}`
                : `Resolved issue recurred: ${opts.issue.title}`,
          detail: {
            origin: opts.origin,
            previousIncidentId: opts.previousIncident.id,
            issueId: opts.issue.id,
            issueTitle: opts.issue.title,
          },
          dedupeKey: `incident_opened_from_recurrence:${opts.issue.id}:${now.getTime()}`,
          processedAt: now,
        });
        await repository.insertEventInTx(tx, {
          incidentId: incident.id,
          kind: "issue_reopened",
          summary: `Issue back to open: ${opts.issue.title}`,
          detail: { issueId: opts.issue.id, origin: opts.origin },
          dedupeKey: `issue_reopened:${opts.issue.id}:${now.getTime()}`,
          processedAt: now,
        });
        // Leave a pointer on the predecessor's timeline too, so someone
        // reading the closed incident sees where the story continued.
        await repository.insertEventInTx(tx, {
          incidentId: opts.previousIncident.id,
          kind: "issue_recurred",
          summary:
            opts.origin === "alert_breached_again"
              ? "Alert breached again; investigation continued in a new incident."
              : "Linked issue recurred; investigation continued in a new incident.",
          detail: {
            issueId: opts.issue.id,
            issueTitle: opts.issue.title,
            newIncidentId: incident.id,
            origin: opts.origin,
          },
          dedupeKey: `issue_recurred:${opts.issue.id}:${now.getTime()}`,
          processedAt: now,
        });
        return incident;
      });
      try {
        await enqueueIncidentCreated(created.id, database);
      } catch (err) {
        console.error("failed to enqueue incident.created webhook", {
          incidentId: created.id,
          err,
        });
      }
      return (
        (await database.query.incidents.findFirst({
          where: eq(schema.incidents.id, created.id),
        })) ?? created
      );
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
  if (input.issueOutcome && input.issueOutcomes) {
    throw new Error("issueOutcome and issueOutcomes are mutually exclusive");
  }
  const resolvedAt = input.resolvedAt ?? new Date();
  // Serialize against Issue linking before taking the complete Issue snapshot.
  // A linker that commits first is included in validation; a resolver that
  // commits first leaves no open Incident for a late linker to target.
  const incident = await repository.lockOpenIncidentInTx(tx, input.incidentId);
  if (!incident) return { resolved: false, resolvedIssueCount: 0 };
  // Validate the entire set before flipping either the Incident or an Issue.
  // The surrounding transaction remains the final safety net if any later
  // write fails.
  const issues = await repository.listCurrentIssuesForIncidentInTx(tx, input.incidentId);
  if (input.issueOutcomes) {
    const validation = validateCompleteIncidentIssueOutcomes(issues, input.issueOutcomes);
    if (!validation.ok) {
      throw new Error(`Invalid issue outcomes: ${validation.errors.join(" ")}`);
    }
  }
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

  // Cascade the issue disposition. Only issues whose *current* incident is
  // this one are touched — an issue that already recurred into a newer
  // incident belongs to that investigation.
  const outcome: ResolveIssueOutcome = input.issueOutcome ?? { kind: "resolve" };
  let resolvedIssueCount = 0;
  if (input.issueOutcomes || outcome.kind !== "none") {
    resolvedIssueCount = issues.length;
    const explicitByIssue = new Map(
      (input.issueOutcomes ?? []).map((issueOutcome) => [issueOutcome.issueId, issueOutcome]),
    );
    for (const issue of issues) {
      // Alert-episode issues are only ever open or resolved (no silenced /
      // under-observation: a noisy alert is tuned or disabled, not silenced
      // per episode), so a silence/observe cascade resolves them plainly.
      const explicit = explicitByIssue.get(issue.id);
      const issueOutcome: ResolveIssueOutcome = explicit
        ? explicit.action === "silence"
          ? { kind: "silence" }
          : explicit.action === "observe"
            ? { kind: "observe", trigger: explicit.trigger as schema.IssueEscalationTrigger }
            : { kind: "resolve" }
        : issue.kind === "alert"
          ? { kind: "resolve" }
          : outcome;
      const patch =
        issueOutcome.kind === "silence"
          ? buildIssueSilencePatch(resolvedAt)
          : issueOutcome.kind === "observe"
            ? buildIssueObservePatch({
                trigger: issueOutcome.trigger,
                baselineEventCount: issue.eventCount,
                now: resolvedAt,
              })
            : buildIssueResolvePatch();
      await repository.updateIssueInTx(tx, issue.id, patch);
      const eventKind =
        issueOutcome.kind === "silence"
          ? "issue_silenced"
          : issueOutcome.kind === "observe"
            ? "issue_observed"
            : "issue_resolved";
      await repository.insertEventInTx(tx, {
        agentRunId: input.agentRunId ?? null,
        incidentId: input.incidentId,
        kind: eventKind,
        summary:
          issueOutcome.kind === "silence"
            ? `Issue silenced: ${issue.title}`
            : issueOutcome.kind === "observe"
              ? `Issue placed under observation: ${issue.title}`
              : `Issue resolved: ${issue.title}`,
        detail: {
          issueId: issue.id,
          issueTitle: issue.title,
          ...(explicit ? { reason: explicit.reason, evidence: explicit.evidence } : {}),
          ...(issueOutcome.kind === "observe"
            ? { trigger: issueOutcome.trigger, baselineEventCount: issue.eventCount }
            : {}),
        },
        dedupeKey: `${eventKind}:${issue.id}:${resolvedAt.getTime()}`,
        processedAt: resolvedAt,
      });
    }
  }

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
}): Promise<{ ok: boolean; reason?: string; incidentId?: string; resolved?: boolean }> {
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
    const resolveResult = await resolveIncidentInTx(
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
    // `resolved` is false when the incident was already closed by a concurrent
    // path (manual resolve, PR merge, …) — resolveIncidentInTx is a no-op then.
    // Only signal a resolve when this call actually flipped the status, so we
    // don't emit a duplicate incident.updated webhook.
    return { ok: true, incidentId: row.incidentId, resolved: resolveResult.resolved };
  });
  if (outcome.ok && outcome.resolved && outcome.incidentId) {
    await emitIncidentResolved(db, outcome.incidentId);
  }
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
