import {
  type AgentRunFollowUpInteraction,
  db,
  requestFollowUpAgentRun,
  schema,
} from "@superlog/db";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { AgentRunContext } from "../agent-run-context.js";
import { createAgentRunLifecycle } from "../agent-run.js";
import type { AgentRunnerBackend } from "../agent-runner-backend.js";
import { getAgentRunnerBackend } from "../infra/agent-runner/backend.js";
import { logger } from "../logger.js";
import { failAgentRun, isTransientError } from "./status.js";

const agentRunLifecycle = createAgentRunLifecycle(db);

export type PendingResumeInput = Pick<schema.IncidentEvent, "id" | "kind" | "summary" | "detail">;

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
  const humanInputs = opts.inputs.filter((event) => event.kind === "human_reply");
  const deliveryInputs = humanInputs.length > 0 ? humanInputs : opts.inputs;
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

export function resumeInputEventKinds(
  agentRun: Pick<schema.AgentRun, "state" | "result">,
): Array<"human_reply" | "incident_context_changed"> {
  if (agentRun.state === "awaiting_events" && agentRun.result?.waitReason === "external_cause") {
    return ["human_reply", "incident_context_changed"];
  }
  return ["human_reply"];
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
// When the provider session can't be resumed (never created, or reclaimed by
// the provider after its TTL) we fall back to a cold-start follow-up run that
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
      await coldStartFallback(ctx, resumeInputs);
      return;
    }
    await agentRunLifecycle.requeueAfterHumanReply({
      id: ctx.agentRun.id,
      currentState: ctx.agentRun.state,
    });
    await markProcessed(resumeInputs.map((event) => event.id));
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

  try {
    const runner = await getAgentRunnerBackend(ctx.agentRun.runtime);
    const outcome = await resumeDurableAgentRun({
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
    });
    if (outcome === "superseded") {
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
      },
      "agent run resumed from pending input",
    );
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
    // A non-transient resume error on a continuation almost always means the
    // provider session is gone (TTL-reclaimed). Don't alarm the thread with an
    // "Investigation failed" card — quietly fall back to a fresh follow-up that
    // re-seeds the prior context. For the classic awaiting_human pause we keep
    // the existing hard-fail.
    if (isContinuation) {
      logger.warn(
        {
          err,
          scope: "agent_run",
          agent_run_id: ctx.agentRun.id,
          incident_id: ctx.incident.id,
          provider_session_id: sessionId,
          stage: "resume",
        },
        "could not resume durable session; falling back to a cold-start follow-up",
      );
      await coldStartFallback(ctx, resumeInputs);
      return;
    }
    await failAgentRun(ctx, "resume_failed", "Failed to resume agent run.", { err });
  }
}

// Session unresumable → mark this run terminal quietly (no failure card) and
// enqueue a fresh follow-up run that carries the prior context + the human's
// message, so the conversation continues even across a lost session.
async function coldStartFallback(
  ctx: AgentRunContext,
  resumeInputs: Awaited<ReturnType<typeof loadUnprocessedResumeInputs>>,
): Promise<void> {
  const combined = resumeInputs
    .map((event) => event.summary ?? "")
    .filter(Boolean)
    .reverse()
    .join("\n\n");
  const first = resumeInputs[resumeInputs.length - 1];
  const origin = (first?.detail as { origin?: AgentRunFollowUpInteraction } | null)?.origin ?? null;

  await agentRunLifecycle.fail({
    id: ctx.agentRun.id,
    currentState: ctx.agentRun.state,
    reason: "resume_failed",
    summary: "Provider session expired; continuing as a fresh follow-up.",
    category: "infrastructure",
    existingResult: ctx.agentRun.result ?? null,
  });

  const result = await requestFollowUpAgentRun(db, {
    incidentId: ctx.incident.id,
    trigger: origin?.channel ?? "slack_reply",
    interaction: origin ?? {
      channel: "slack_reply",
      author: null,
      text: combined,
      occurredAt: new Date().toISOString(),
    },
  });

  // Don't silently swallow the human's message: if the fallback couldn't
  // enqueue (cap reached, gate off, another run already active), surface it
  // loudly. We still mark the replies processed so the now-failed run doesn't
  // re-attempt the dead session every tick.
  if (result.outcome === "skipped") {
    logger.warn(
      {
        scope: "agent_run",
        agent_run_id: ctx.agentRun.id,
        incident_id: ctx.incident.id,
        reason: result.reason,
        dropped_text: combined.slice(0, 500),
      },
      "cold-start fallback could not enqueue; human input not actioned",
    );
  }

  await markProcessed(resumeInputs.map((event) => event.id));
}
