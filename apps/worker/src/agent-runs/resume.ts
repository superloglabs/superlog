import {
  type AgentRunFollowUpInteraction,
  INBOUND_INTERACTION_EVENT_KINDS,
  type InboundInteractionEventKind,
  type RequestFollowUpResult,
  type ResolveIncidentAfterAgentPullRequestsMergedResult,
  db,
  isInboundInteractionEventKind,
  isIncidentResolutionProofCurrent,
  requestFollowUpAgentRun,
  latestAgentPullRequestSettlementAt,
  resolveIncidentIfAllAgentPullRequestsSettled,
  schema,
} from "@superlog/db";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { AgentRunContext } from "../agent-run-context.js";
import { createAgentRunLifecycle } from "../agent-run.js";
import type { AgentRunnerBackend, SessionDeliveryErrorKind } from "../agent-runner-backend.js";
import { investigationGate } from "../billing/investigation-gate.js";
import { usageNotifier } from "../billing/usage-notifier-infra.js";
import { getAgentRunnerBackend } from "../infra/agent-runner/backend.js";
import { logger } from "../logger.js";
import { completeWithoutPullRequest } from "./completion.js";
import { failAgentRun, isTransientError } from "./status.js";

const agentRunLifecycle = createAgentRunLifecycle(db);

export type PendingResumeInput = Pick<schema.IncidentEvent, "id" | "kind" | "summary" | "detail">;

type MergedPullRequestContinuation = {
  agentPrId: string;
  occurredAt: string;
};

export type UnresumableContinuationRecoveryOutcome =
  | { kind: "resolved" }
  | { kind: "incident_not_open" }
  | { kind: "cold_start"; result: RequestFollowUpResult; inputText: string };

// A redelivery after resolution reports `incident_not_open`, so the PR event's
// exact resolution proof — not that broad disposition — decides whether this
// worker may publish or touch completion metadata. Accounting happens only on
// the first `resolved` attempt; a failed publication can retry without charging
// the investigation twice.
export async function finalizeCurrentMergedPullRequestResolution(opts: {
  disposition: "resolved" | "incident_not_open";
  isCurrentResolution(): Promise<boolean>;
  accountResolution(): Promise<void>;
  finalizeRun(): Promise<void>;
}): Promise<"finalized" | "stale"> {
  if (!(await opts.isCurrentResolution())) return "stale";
  if (opts.disposition === "resolved") await opts.accountResolution();
  await opts.finalizeRun();
  return "finalized";
}

function interactionOrigin(input: PendingResumeInput): AgentRunFollowUpInteraction | null {
  const origin = input.detail?.origin;
  return origin && typeof origin === "object" && !Array.isArray(origin)
    ? (origin as AgentRunFollowUpInteraction)
    : null;
}

function mergedPullRequestContinuation(
  inputs: PendingResumeInput[],
): MergedPullRequestContinuation | null {
  for (const input of [...inputs].reverse()) {
    const origin = interactionOrigin(input);
    if (
      origin?.channel === "pr_merged" &&
      typeof origin.agentPrId === "string" &&
      origin.agentPrId.length > 0
    ) {
      return { agentPrId: origin.agentPrId, occurredAt: origin.occurredAt };
    }
  }
  return null;
}

// A recorded lifecycle event only proves that the continuation is durable.
// Once the provider proves the old session is permanently unavailable, apply
// the same all-PRs-merged fallback as the webhook/recovery paths before trying
// a gated cold-start follow-up. Transient provider errors never reach this use
// case, so its input remains unprocessed and retryable in that case.
export async function recoverUnresumableContinuation(opts: {
  inputs: PendingResumeInput[];
  resolveMergedPullRequest(
    input: MergedPullRequestContinuation,
  ): Promise<ResolveIncidentAfterAgentPullRequestsMergedResult>;
  publishResolvedRun(
    input: MergedPullRequestContinuation,
    disposition: "resolved" | "incident_not_open",
  ): Promise<void>;
  failCurrentRun(): Promise<void>;
  requestFollowUp(interaction: AgentRunFollowUpInteraction): Promise<RequestFollowUpResult>;
  markProcessed(ids: string[]): Promise<void>;
}): Promise<UnresumableContinuationRecoveryOutcome> {
  const combined = opts.inputs
    .map((event) => event.summary ?? "")
    .filter(Boolean)
    .reverse()
    .join("\n\n");
  const first = opts.inputs[opts.inputs.length - 1];
  const origin = first ? interactionOrigin(first) : null;
  const mergedContinuation = mergedPullRequestContinuation(opts.inputs);

  if (mergedContinuation) {
    const resolution = await opts.resolveMergedPullRequest(mergedContinuation);
    if (resolution.disposition === "resolved") {
      await opts.publishResolvedRun(mergedContinuation, "resolved");
      await opts.markProcessed(opts.inputs.map((event) => event.id));
      return { kind: "resolved" };
    }
    if (resolution.disposition === "incident_not_open") {
      await opts.publishResolvedRun(mergedContinuation, "incident_not_open");
      await opts.markProcessed(opts.inputs.map((event) => event.id));
      return { kind: "incident_not_open" };
    }
  }

  await opts.failCurrentRun();
  const result = await opts.requestFollowUp(
    origin ?? {
      channel: "slack_reply",
      author: null,
      text: combined,
      occurredAt: new Date().toISOString(),
    },
  );
  await opts.markProcessed(opts.inputs.map((event) => event.id));
  return { kind: "cold_start", result, inputText: combined };
}

export async function resumeDurableAgentRun(opts: {
  sessionId: string;
  inputs: PendingResumeInput[];
  runner: Pick<AgentRunnerBackend, "resume" | "steer">;
  transitionToRunning(): Promise<boolean>;
  markProcessed(ids: string[]): Promise<void>;
}): Promise<"resumed" | "superseded"> {
  // If both a human reply and incident context arrived while parked, resume
  // with the human reply alone. The untouched context event is then steered
  // by the ordinary running-sync path on its next pass, preserving the right
  // framing for both inputs instead of presenting system context as human text.
  const interactionInputs = opts.inputs.filter((event) =>
    isInboundInteractionEventKind(event.kind),
  );
  const deliveryInputs = interactionInputs.length > 0 ? interactionInputs : opts.inputs;
  const combined = deliveryInputs
    .map((event) => event.summary ?? "")
    .filter(Boolean)
    .reverse()
    .join("\n\n");
  const onlyIncidentContext = deliveryInputs.every(
    (event) => event.kind === "incident_context_changed",
  );

  if (onlyIncidentContext) {
    await opts.runner.steer(opts.sessionId, combined || "New issues joined the incident.");
  } else {
    await opts.runner.resume(opts.sessionId, combined);
  }

  const resumed = await opts.transitionToRunning();
  await opts.markProcessed(deliveryInputs.map((event) => event.id));
  return resumed ? "resumed" : "superseded";
}

export type ResumeDeliveryResult =
  | { kind: "delivered"; outcome: "resumed" | "superseded"; repaired: boolean }
  | {
      kind: "failed";
      err: unknown;
      errorKind: SessionDeliveryErrorKind;
      repairAttempted: boolean;
    };

// Deliver pending input into the durable session, repairing a wedged turn at
// most once. A runtime rejects new messages while the session's turn is still
// open on unanswered tool events (a run that parked mid-turn) — the session is
// alive, so discarding it for a cold-start follow-up would throw away the
// whole investigation context. When the backend can classify that state and
// interrupt the open turn, do so and retry the delivery in place. Transient
// errors are rethrown untouched so the caller's next-tick retry applies.
export async function deliverResumeRepairingWedgedTurn(opts: {
  attempt(): Promise<"resumed" | "superseded">;
  classifyError(err: unknown): SessionDeliveryErrorKind;
  interruptOpenTurn: (() => Promise<void>) | null;
}): Promise<ResumeDeliveryResult> {
  try {
    return { kind: "delivered", outcome: await opts.attempt(), repaired: false };
  } catch (err) {
    if (isTransientError(err)) throw err;
    const errorKind = opts.classifyError(err);
    if (errorKind !== "wedged_turn" || !opts.interruptOpenTurn) {
      return { kind: "failed", err, errorKind, repairAttempted: false };
    }
    try {
      await opts.interruptOpenTurn();
      return { kind: "delivered", outcome: await opts.attempt(), repaired: true };
    } catch (retryErr) {
      if (isTransientError(retryErr)) throw retryErr;
      return {
        kind: "failed",
        err: retryErr,
        errorKind: opts.classifyError(retryErr),
        repairAttempted: true,
      };
    }
  }
}

export function resumeInputEventKinds(
  agentRun: Pick<schema.AgentRun, "state" | "result">,
): Array<InboundInteractionEventKind | "incident_context_changed"> {
  if (agentRun.state === "awaiting_events" && agentRun.result?.waitReason === "external_cause") {
    return [...INBOUND_INTERACTION_EVENT_KINDS, "incident_context_changed"];
  }
  return [...INBOUND_INTERACTION_EVENT_KINDS];
}

async function loadUnprocessedResumeInputs(
  agentRun: Pick<schema.AgentRun, "id" | "state" | "result">,
) {
  return db.query.incidentEvents.findMany({
    where: and(
      eq(schema.incidentEvents.agentRunId, agentRun.id),
      inArray(schema.incidentEvents.kind, resumeInputEventKinds(agentRun)),
      isNull(schema.incidentEvents.processedAt),
    ),
    orderBy: [desc(schema.incidentEvents.createdAt)],
  });
}

async function markProcessed(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(schema.incidentEvents)
    .set({ processedAt: new Date() })
    .where(inArray(schema.incidentEvents.id, ids));
}

// Resume a run from pending input. Handles two source states:
//   - `awaiting_human`: the agent paused to ask a question (the classic resume).
//   - `resuming`: a previously-terminal run that an inbound message reactivated
//     (talking to a finished investigation). The durable provider session is
//     continued in place — no re-investigation.
// An external-cause `awaiting_events` run additionally treats newly-arrived
// incident context as resumable input, so fresh evidence wakes the parked
// investigation without requiring an unrelated human reply.
// A session that parked mid-turn (unanswered tool events) rejects new
// messages even though it is alive; when the backend can classify that state
// we interrupt the open turn and deliver in place, preserving the session.
// Only when the session truly can't be resumed (never created, or reclaimed
// by the provider) do we fall back to a cold-start follow-up run that
// re-seeds the prior context, so the human's message is never silently lost.
export async function resumeAgentRunFromHumanInput(ctx: AgentRunContext): Promise<void> {
  const sessionId = ctx.agentRun.providerSessionId;
  // `resuming` (a reactivated terminal run) and `awaiting_events` (parked on
  // PR review) are continuations: every resume is driven by an intentional
  // external event, so the human-resume budget doesn't apply.
  const isContinuation =
    ctx.agentRun.state === "resuming" || ctx.agentRun.state === "awaiting_events";

  if (!sessionId) {
    // `awaiting_human` paused before any managed session existed (repo
    // discovery couldn't pick a candidate). Bounce back to "queued" on a human
    // reply so the next tick reloads ctx with the repo the human named. A
    // `resuming` run always has a session (we only reactivate when one exists),
    // but guard with a cold-start fallback in case it doesn't.
    const resumeInputs = await loadUnprocessedResumeInputs(ctx.agentRun);
    if (resumeInputs.length === 0) return;
    if (isContinuation) {
      await coldStartFallback(ctx, resumeInputs, "session_gone");
      return;
    }
    const requeued = await agentRunLifecycle.requeueAfterHumanReply({
      id: ctx.agentRun.id,
      incidentId: ctx.incident.id,
      currentState: ctx.agentRun.state,
    });
    await markProcessed(resumeInputs.map((event) => event.id));
    if (!requeued) return;
    return;
  }

  // The human-resume budget guards a runaway agent that keeps re-pinging the
  // human; it does not apply to human-initiated continuation, where every
  // resume is an intentional message.
  if (!isContinuation && ctx.agentRun.resumeCount >= ctx.automation.maxHumanResumeCount) {
    await failAgentRun(
      ctx,
      "human_resume_budget_exhausted",
      "Investigation stalled after exhausting the human resume budget.",
    );
    return;
  }

  const resumeInputs = await loadUnprocessedResumeInputs(ctx.agentRun);
  if (resumeInputs.length === 0) return;

  let delivery: ResumeDeliveryResult;
  try {
    const runner = await getAgentRunnerBackend(ctx.agentRun.runtime);
    const interrupt = runner.interrupt?.bind(runner);
    delivery = await deliverResumeRepairingWedgedTurn({
      attempt: () =>
        resumeDurableAgentRun({
          sessionId,
          inputs: resumeInputs,
          runner,
          transitionToRunning: () =>
            agentRunLifecycle.resumeRunning({
              id: ctx.agentRun.id,
              currentState: ctx.agentRun.state,
              currentResumeCount: ctx.agentRun.resumeCount,
              continuation: isContinuation,
            }),
          markProcessed,
        }),
      classifyError: (err) => runner.classifyDeliveryError?.(err) ?? "unknown",
      interruptOpenTurn: interrupt ? () => interrupt(sessionId) : null,
    });
  } catch (err) {
    if (isTransientError(err)) {
      logger.error(
        {
          err,
          scope: "agent_run",
          agent_run_id: ctx.agentRun.id,
          incident_id: ctx.incident.id,
          project_id: ctx.project.id,
          org_id: ctx.project.orgId,
          provider_session_id: sessionId,
          stage: "resume",
        },
        "agent run resume hit transient error; will retry on next tick",
      );
      return;
    }
    delivery = { kind: "failed", err, errorKind: "unknown", repairAttempted: false };
  }

  if (delivery.kind === "failed") {
    // Only a provably-gone session justifies discarding the durable context.
    // Wedged turns are repaired above; whatever still fails here (repair
    // exhausted, or an unclassifiable error) falls back so the human's input
    // is never silently lost. Don't alarm the thread with an "Investigation
    // failed" card on a continuation — quietly enqueue a fresh follow-up that
    // re-seeds the prior context. For the classic awaiting_human pause we keep
    // the existing hard-fail.
    if (isContinuation) {
      logger.warn(
        {
          err: delivery.err,
          scope: "agent_run",
          agent_run_id: ctx.agentRun.id,
          incident_id: ctx.incident.id,
          provider_session_id: sessionId,
          stage: "resume",
          delivery_error_kind: delivery.errorKind,
          repair_attempted: delivery.repairAttempted,
        },
        "could not resume durable session; falling back to a cold-start follow-up",
      );
      await coldStartFallback(ctx, resumeInputs, delivery.errorKind);
      return;
    }
    await failAgentRun(ctx, "resume_failed", "Failed to resume agent run.", { err: delivery.err });
    return;
  }

  if (delivery.outcome === "superseded") {
    logger.info(
      {
        scope: "agent_run",
        agent_run_id: ctx.agentRun.id,
        incident_id: ctx.incident.id,
        session_id: sessionId,
      },
      "resume input reached the durable session after the run had already transitioned",
    );
    return;
  }
  logger.info(
    {
      scope: "agent_run",
      agent_run_id: ctx.agentRun.id,
      incident_id: ctx.incident.id,
      session_id: sessionId,
      continuation: isContinuation,
      resume_count: ctx.agentRun.resumeCount + 1,
      input_count: resumeInputs.length,
      turn_repaired: delivery.repaired,
    },
    delivery.repaired
      ? "agent run resumed from pending input after interrupting a wedged turn"
      : "agent run resumed from pending input",
  );
}

// Session unresumable → resolve a completed PR delivery deterministically, or
// mark this run terminal quietly and enqueue a context-carrying follow-up.
async function coldStartFallback(
  ctx: AgentRunContext,
  resumeInputs: Awaited<ReturnType<typeof loadUnprocessedResumeInputs>>,
  errorKind: SessionDeliveryErrorKind,
): Promise<void> {
  const recovery = await recoverUnresumableContinuation({
    inputs: resumeInputs,
    async resolveMergedPullRequest(input) {
      const agentPr = await db.query.agentPullRequests.findFirst({
        where: and(
          eq(schema.agentPullRequests.id, input.agentPrId),
          eq(schema.agentPullRequests.incidentId, ctx.incident.id),
        ),
      });
      if (!agentPr || agentPr.state !== "merged") {
        return {
          disposition: "pull_requests_pending",
          resolved: false,
          resolvedIssueCount: 0,
        };
      }
      const occurredAt = new Date(input.occurredAt);
      const fallbackResolvedAt =
        agentPr.mergedAt ?? (Number.isFinite(occurredAt.getTime()) ? occurredAt : new Date());
      // Settled guard, not all-merged: a sibling PR closed without merge must
      // not leave the incident open when this merge is the last settle event.
      return resolveIncidentIfAllAgentPullRequestsSettled({
        incidentId: ctx.incident.id,
        settlementEvidenceAt: fallbackResolvedAt,
        buildInput: (lockedPullRequests) => ({
          incidentId: ctx.incident.id,
          kind: "agent_pr_merged" as const,
          reasonCode: "agent_pr_merged",
          reasonText: `Resolved because agent PR #${agentPr.prNumber} (${agentPr.repoFullName}) was merged${
            agentPr.mergedByLogin ? ` by @${agentPr.mergedByLogin}` : ""
          }.`,
          agentRunId: agentPr.agentRunId,
          resolvingAgentRunId: null,
          eventSummary: `Incident resolved because PR #${agentPr.prNumber} was merged.`,
          eventDetail: {
            agentPrId: agentPr.id,
            repoFullName: agentPr.repoFullName,
            prNumber: agentPr.prNumber,
            prUrl: agentPr.url,
            mergedByLogin: agentPr.mergedByLogin,
          },
          eventDedupeKey: `incident_resolved:agent_pr:${agentPr.id}`,
          resolvedAt: latestAgentPullRequestSettlementAt(lockedPullRequests) ?? fallbackResolvedAt,
        }),
      });
    },
    async publishResolvedRun(input, disposition) {
      const agentPr = await db.query.agentPullRequests.findFirst({
        where: and(
          eq(schema.agentPullRequests.id, input.agentPrId),
          eq(schema.agentPullRequests.incidentId, ctx.incident.id),
        ),
      });
      if (!agentPr) {
        throw new Error(`merged PR continuation ${input.agentPrId} no longer exists`);
      }
      const resolutionProof = {
        agentRunId: agentPr.agentRunId,
        eventDedupeKey: `incident_resolved:agent_pr:${agentPr.id}`,
      };
      await finalizeCurrentMergedPullRequestResolution({
        disposition,
        isCurrentResolution: () =>
          isIncidentResolutionProofCurrent({
            incidentId: ctx.incident.id,
            resolutionProof,
          }),
        accountResolution: async () => {
          await investigationGate.recordInvestigation(ctx.project.orgId);
          void usageNotifier?.notify(ctx.project.orgId);
        },
        finalizeRun: async () => {
          const finalized = await completeWithoutPullRequest(
            ctx,
            ctx.agentRun.result
              ? { ...ctx.agentRun.result, state: "complete" }
              : {
                  state: "complete",
                  summary: "Incident resolved after every agent pull request was merged.",
                },
            ctx.agentRun.providerSessionId,
            ctx.agentRun.cumulativeRuntimeMinutes,
            {
              runCompletion: "already_committed_by_resolution",
              incidentOutcome: {
                kind: "all_pull_requests_merged",
                prNumber: agentPr.prNumber,
                repoFullName: agentPr.repoFullName,
                resolutionProof,
              },
            },
          );
          if (!finalized) {
            throw new Error("merged PR resolution did not atomically complete the agent run");
          }
        },
      });
    },
    async failCurrentRun() {
      await agentRunLifecycle.fail({
        id: ctx.agentRun.id,
        currentState: ctx.agentRun.state,
        reason: "resume_failed",
        // Only claim expiry when the provider proved the session is gone —
        // any other failure gets the honest, unspecific wording.
        summary:
          errorKind === "session_gone"
            ? "Provider session expired; continuing as a fresh follow-up."
            : "Provider session could not be resumed; continuing as a fresh follow-up.",
        category: "infrastructure",
        existingResult: ctx.agentRun.result ?? null,
      });
    },
    requestFollowUp: (interaction) =>
      requestFollowUpAgentRun(db, {
        incidentId: ctx.incident.id,
        trigger: interaction.channel,
        interaction,
      }),
    markProcessed,
  });

  // Don't silently swallow the human's message: if the fallback couldn't
  // enqueue (cap reached, gate off, another run already active), surface it
  // loudly. We still mark the replies processed so the now-failed run doesn't
  // re-attempt the dead session every tick.
  if (recovery.kind === "cold_start" && recovery.result.outcome === "skipped") {
    logger.warn(
      {
        scope: "agent_run",
        agent_run_id: ctx.agentRun.id,
        incident_id: ctx.incident.id,
        reason: recovery.result.reason,
        dropped_text: recovery.inputText.slice(0, 500),
      },
      "cold-start fallback could not enqueue; human input not actioned",
    );
  }
}
