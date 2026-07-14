import { type AgentRunResult, db, schema } from "@superlog/db";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  TERMINAL_OUTCOME_NUDGE_MARKER,
  assembleAgentRunResult,
} from "../agent-outcome-tools.js";
import type { AgentRunContext } from "../agent-run-context.js";
import { createAgentRunLifecycle } from "../agent-run.js";
import { type AgentRunOutcome, recordAgentRunCompletion } from "../ai-usage.js";
import { investigationGate } from "../billing/investigation-gate.js";
import { usageNotifier } from "../billing/usage-notifier-infra.js";
import { getAgentRunnerBackend } from "../infra/agent-runner/backend.js";
import { postIncidentThreadMessage } from "../infra/slack/incident-messages.js";
import { type ResolvedIntegration, loadEnabledIntegrationsForOrg } from "../integrations.js";
import { logger } from "../logger.js";
import { completeWithIncidentResolution, completeWithoutPullRequest } from "./completion.js";
import { recordFiledLinearTicket } from "./deliverable-records.js";
import { deliverLinearTicket } from "./linear-delivery.js";
import { linkLinearTicketToPullRequests } from "./linear-pr-linking.js";
import { tryMergeAfterAgentRun } from "./merge.js";
import { hasRevylCreateTestIntegration, looksLikeMobileChange } from "./mobile-regression.js";
import { createOutcomeActionExecutor } from "./outcome-actions.js";
import { completeWithPullRequest, resolvePullRequestBaseBranch } from "./pr-delivery.js";
import { applyIncidentMetadataFromResult } from "./result-metadata.js";
import {
  awaitingHumanSecondsFromEvents,
  exceededWallClockBudget,
  failAgentRun,
  isTransientError,
  moveAgentRunToAwaitingEvents,
  moveAgentRunToAwaitingHuman,
} from "./status.js";

export { hasRevylCreateTestIntegration } from "./mobile-regression.js";

export function isCompleteInvestigationAllowed(
  result: AgentRunResult,
  capabilities: {
    prPolicy: schema.PrPolicy;
    githubConnected: boolean;
    approvalPromptsEnabled: boolean;
    approvalPromptToolsAvailable: boolean;
  },
): boolean {
  if (result.completionKind !== "investigation_complete") return true;
  const prCreation = capabilities.githubConnected && capabilities.prPolicy !== "never";
  const approvalPrompts =
    capabilities.approvalPromptsEnabled && capabilities.approvalPromptToolsAvailable;
  return !prCreation && !approvalPrompts;
}

const agentRunLifecycle = createAgentRunLifecycle(db);

// Wall-clock seconds a run has spent parked in `awaiting_human`, excluded from
// the wall-clock budget so a run that legitimately waits on a human reply isn't
// reaped the moment it resumes (prod incident 2026-07-09). Derived from the
// run's lifecycle events; defaults to 0 if the lookup fails so a telemetry
// hiccup can never make the budget stricter than it already was.
async function loadAwaitingHumanSeconds(
  agentRunId: string,
  startedAt: Date | null,
  now: Date,
): Promise<number> {
  if (!startedAt) return 0;
  try {
    const events = await db
      .select({
        kind: schema.incidentEvents.kind,
        createdAt: schema.incidentEvents.createdAt,
      })
      .from(schema.incidentEvents)
      .where(
        and(
          eq(schema.incidentEvents.agentRunId, agentRunId),
          inArray(schema.incidentEvents.kind, ["awaiting_human", "resumed"]),
        ),
      );
    return awaitingHumanSecondsFromEvents({ events, startedAt, now });
  } catch (err) {
    logger.error(
      { err, scope: "agent_run", agent_run_id: agentRunId },
      "failed to load awaiting_human duration for wall-clock budget; treating as 0",
    );
    return 0;
  }
}

export type PendingContextEvent = {
  id: string;
  summary: string | null;
};

// A session can report "idle" while the model is actually mid-flight: the
// collector acks a tool call, the model immediately issues its next one, and
// a user.message steer sent in the same tick 400s with "waiting on responses
// to events [...]". That race is inherent to steering from a poller — the
// only correct handling is to skip this tick and retry on the next, when the
// session is genuinely quiescent. Treating the 400 as fatal killed real runs
// with `sync_failed`.
export function isSessionBusyError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("waiting on responses to events");
}

// "steered": the delta was delivered and the caller must stop this tick.
// "busy": the session rejected the steer mid-flight; events stay pending and
// the caller must ALSO stop this tick — proceeding could complete the run out
// from under a pending human reply. "not_applicable": nothing to steer.
export type IdleSteerOutcome = "steered" | "busy" | "not_applicable";

export async function steerIdleRunnerWithPendingContext(opts: {
  snapshotStatus: string;
  pendingContextEvents: PendingContextEvent[];
  runner: { steer(sessionId: string, message: string): Promise<void> };
  sessionId: string;
  incidentId: string;
  markEventsProcessed(ids: string[]): Promise<void>;
  notifySteered(incidentId: string): Promise<void>;
}): Promise<IdleSteerOutcome> {
  if (opts.snapshotStatus !== "idle" || opts.pendingContextEvents.length === 0) {
    return "not_applicable";
  }
  const delta = opts.pendingContextEvents
    .map((event) => event.summary)
    .filter((value): value is string => !!value)
    .join("\n");
  try {
    await opts.runner.steer(opts.sessionId, delta || "New issues joined the incident.");
  } catch (err) {
    if (isSessionBusyError(err)) {
      // Model is mid-tool-call despite the idle status; leave the events
      // unprocessed so the next tick retries the steer.
      return "busy";
    }
    throw err;
  }
  await opts.markEventsProcessed(opts.pendingContextEvents.map((event) => event.id));
  await opts.notifySteered(opts.incidentId);
  return "steered";
}

type MobileRegressionToolLookupState = "enabled" | "disabled" | "failed";
type MobileRegressionGateState = "allow" | "repair" | "defer_lookup";

export function needsMobileRegressionRepair(opts: {
  revylEnabled: boolean;
  service: string | null;
  result: AgentRunResult;
}): boolean {
  return (
    mobileRegressionGateState({
      toolLookup: opts.revylEnabled ? "enabled" : "disabled",
      service: opts.service,
      result: opts.result,
    }) === "repair"
  );
}

export function mobileRegressionGateState(opts: {
  toolLookup: MobileRegressionToolLookupState;
  service: string | null;
  result: AgentRunResult;
}): MobileRegressionGateState {
  if (opts.result.state !== "complete") return "allow";
  const pr = opts.result.pr;
  if (!pr || pr.validationPassed !== true) return "allow";
  if (opts.result.mobileRegressionTest) return "allow";

  if (!looksLikeMobileChange({ service: opts.service, changedFiles: pr.changedFiles })) {
    return "allow";
  }
  if (opts.toolLookup === "failed") return "defer_lookup";
  if (opts.toolLookup === "enabled") return "repair";
  return "allow";
}

function mobileRegressionGateFailureSummary(
  gateState: Exclude<MobileRegressionGateState, "allow">,
) {
  if (gateState === "defer_lookup") {
    return "Investigation exceeded its wall-clock budget while checking the mobile regression integration.";
  }
  return "Investigation exceeded its wall-clock budget while waiting for a mobile regression test decision.";
}

export function mobileRegressionGateTerminatedSummary(
  gateState: Exclude<MobileRegressionGateState, "allow">,
) {
  if (gateState === "defer_lookup") {
    return "Investigation terminated before the mobile regression integration could be checked.";
  }
  return "Investigation terminated before producing the required mobile regression test decision.";
}

export function mobileRegressionRepairPrompt(): string {
  return [
    "Your previous result proposed a mobile PR while Revyl is enabled, but it did not include a mobile regression test decision.",
    "Repair this omission by calling `propose_pr` again with the same PR fields plus the missing mobile fields.",
    'If the fix can be covered by a reliable mobile user flow, author the Revyl YAML, call `revyl_validate_yaml`, then call `revyl_create_test_from_yaml`, and call `propose_pr` again with `mobileTestStatus="created"` plus the returned test id as `mobileTestId`.',
    'If it cannot be represented as a reliable mobile user flow, call `propose_pr` again with `mobileTestStatus="skipped"` and a concrete `mobileTestReason`.',
    'Use `mobileTestStatus="not_applicable"` only for backend-only, noise-only, development-only, or non-mobile incidents, and include a concrete `mobileTestReason`.',
  ].join("\n");
}

// A sync pass that just sent custom_tool_result acks has unblocked the
// model: the snapshot's "idle" status predates those acks, so the agent is
// about to resume with the tool results. A steer (human reply, context delta,
// or the terminal nudge) sent into that window is queued behind the open turn
// and delivered AFTER the model's next event — which can be its terminal
// outcome call, whose turn would then be reset out from under it. Defer all
// steering to the next tick, when the session state has settled. A result
// means the run is concluding; the completion paths below own it.
//
// Acks reach the session on two paths, and both open the same race window:
// `sentToolAckCount` counts the collect pass's acks (report_findings etc.),
// `dispatchedToolCallCount` counts the dispatch pass's (action tools, the
// resolve_incident guard) — the dispatch loop sends those before collect
// runs, so they never show up in the collect count.
export function shouldDeferSteering(snapshot: {
  result: unknown;
  sentToolAckCount?: number;
  dispatchedToolCallCount?: number;
}): boolean {
  return (
    !snapshot.result &&
    ((snapshot.sentToolAckCount ?? 0) > 0 || (snapshot.dispatchedToolCallCount ?? 0) > 0)
  );
}

// Steered into a session that went idle without calling any terminal outcome
// tool and with nothing pending (no open PRs to wait on). Fired at most once
// per session; the runtime/wall-clock budgets stay the hard floor.
//
// Opens with TERMINAL_OUTCOME_NUDGE_MARKER: the redelivery check below and
// runner backends detect a delivered nudge in the session event stream by
// substring-matching that line (a test pins it as the prompt's exact first
// line). Reword it only via the exported constant, never here — live
// sessions can carry an already-delivered nudge across a deploy.
export function terminalOutcomeNudgePrompt(
  args: {
    completeInvestigationAvailable?: boolean;
  } = {},
): string {
  return [
    TERMINAL_OUTCOME_NUDGE_MARKER,
    args.completeInvestigationAvailable
      ? "Call `report_findings` now, then explicitly end your turn with `complete_investigation`. Use `resolve_incident` only if impact has ceased and every linked issue is classified, or `ask_human` if a concrete human answer is required first."
      : "Call `report_findings` now if you have findings to record, classify each linked issue (`silence_as_noise`, `place_under_observation`, or `resolve_issue`), open any needed PR with `propose_pr`, and then end your turn by calling `resolve_incident` — or `ask_human` if a human must act or answer first.",
  ].join("\n");
}

export async function syncRunningAgentRun(ctx: AgentRunContext): Promise<void> {
  const sessionId = ctx.agentRun.providerSessionId;
  if (!sessionId) {
    await failAgentRun(ctx, "missing_session", "Investigation has no managed session ID.");
    return;
  }

  // Time parked awaiting a human is excluded from every wall-clock check below.
  // Computed once up front so the transient-error path in `catch` can reuse it.
  const awaitingHumanSeconds = await loadAwaitingHumanSeconds(
    ctx.agentRun.id,
    ctx.agentRun.startedAt,
    new Date(),
  );

  try {
    const runner = await getAgentRunnerBackend(ctx.agentRun.runtime);
    const dispatched = await runner
      .dispatchIntegrationToolCalls({
        sessionId,
        orgId: ctx.project.orgId,
        projectId: ctx.project.id,
        incidentId: ctx.incident.id,
        executeOutcomeAction: createOutcomeActionExecutor(ctx, sessionId),
      })
      .catch((err) => {
        logger.error({ err, sessionId }, "integration tool dispatch failed");
        return 0;
      });
    if (dispatched > 0) {
      logger.info({ sessionId, dispatched }, "dispatched custom-tool calls");
    }
    const snapshot = await runner.collect(sessionId);
    for (const event of snapshot.events) {
      await agentRunLifecycle.appendAgentEvent({
        agentRunId: ctx.agentRun.id,
        kind: event.type,
        summary: event.summary,
        providerEventId: event.id,
        detail: event.detail,
      });
    }

    const nextRuntimeMinutes = Math.ceil(snapshot.activeSeconds / 60);
    if (nextRuntimeMinutes >= ctx.automation.maxRuntimeMinutes) {
      await failAgentRun(
        ctx,
        "runtime_budget_exhausted",
        "Investigation stalled after exhausting the runtime budget.",
      );
      return;
    }

    // The provider-active budget above doesn't fire for sessions Anthropic
    // marks idle without an `active_seconds` count — typically because the
    // agent emitted a custom_tool_use we never ack'd. Use wall-clock as a
    // backstop so those runs eventually die instead of accumulating in the
    // 'running' state. Distinct failure reason so you can audit them later.
    // Guard on `!snapshot.result` so we never preempt a run that just
    // submitted right at the budget boundary.
    if (
      !snapshot.result &&
      exceededWallClockBudget({
        startedAt: ctx.agentRun.startedAt,
        now: new Date(),
        maxRuntimeMinutes: ctx.automation.maxRuntimeMinutes,
        awaitingHumanSeconds,
      })
    ) {
      await failAgentRun(
        ctx,
        "wall_clock_timeout",
        "Investigation exceeded its wall-clock budget without producing a result.",
      );
      return;
    }

    // The collector already ack'd these with an error payload so the session
    // can leave requires_action. There's no useful work left on this run.
    // Distinct failure reason makes it easy to audit which agents are
    // hallucinating non-existent tool names.
    if (snapshot.unknownCustomTools.length > 0 && !snapshot.result) {
      const names = snapshot.unknownCustomTools.map((t) => t.name).join(", ");
      await failAgentRun(
        ctx,
        "unknown_custom_tool",
        `Agent called a tool the runtime does not handle: ${names}`,
      );
      return;
    }

    const baseUpdate: Partial<schema.AgentRun> = {
      providerSessionStatus: snapshot.status,
      cumulativeRuntimeMinutes: nextRuntimeMinutes,
      lastSyncedAt: new Date(),
      updatedAt: new Date(),
    };

    const selectedRepoFullName = snapshot.result?.pr?.selectedRepoFullName ?? null;
    const pr = snapshot.result?.pr ?? null;
    const baseBranch = pr ? resolvePullRequestBaseBranch(ctx, pr) : null;
    if (selectedRepoFullName) {
      baseUpdate.selectedRepoFullName = selectedRepoFullName;
    }
    if (baseBranch) {
      baseUpdate.selectedBaseBranch = baseBranch;
    }
    await db
      .update(schema.agentRuns)
      .set(baseUpdate)
      .where(eq(schema.agentRuns.id, ctx.agentRun.id));

    if (
      shouldDeferSteering({
        result: snapshot.result,
        sentToolAckCount: snapshot.sentToolAckCount,
        dispatchedToolCallCount: dispatched,
      })
    ) {
      // This pass acked tool calls (report_findings via collect, action
      // tools / the resolve_incident guard via dispatch) and the model is
      // resuming; the idle status is stale. Steering now races the model's
      // next event — retry every steer on the next tick instead. The budget
      // checks above already ran, so a run can't hide here indefinitely.
      return;
    }

    // A human message that arrived mid-turn (the run was still `running`, so it
    // was recorded rather than reactivating a terminal run). Steer it into the
    // live session the moment the runner is idle — even if a result just landed,
    // so the reply continues the conversation instead of the run completing out
    // from under it. The inbound channel already ack'd the human, so no extra
    // thread post here.
    const pendingHumanReplies = await db.query.incidentEvents.findMany({
      where: and(
        eq(schema.incidentEvents.agentRunId, ctx.agentRun.id),
        eq(schema.incidentEvents.kind, "human_reply"),
        isNull(schema.incidentEvents.processedAt),
      ),
      // Oldest → newest so the steered conversation reads in chronological order.
      orderBy: [asc(schema.incidentEvents.createdAt)],
    });
    const steeredHumanOutcome = await steerIdleRunnerWithPendingContext({
      snapshotStatus: snapshot.status,
      pendingContextEvents: pendingHumanReplies,
      runner,
      sessionId,
      incidentId: ctx.incident.id,
      markEventsProcessed: async (ids) => {
        await db
          .update(schema.incidentEvents)
          .set({ processedAt: new Date() })
          .where(inArray(schema.incidentEvents.id, ids));
      },
      notifySteered: async () => {},
    });
    if (steeredHumanOutcome !== "not_applicable") {
      // Steered: the reply is in the session, wait for its turn. Busy: the
      // reply is still pending — do NOT fall through to completion, or the
      // run would finish out from under it; retry next tick.
      return;
    }

    if (snapshot.result) {
      if (snapshot.result.state === "complete") {
        let toolLookup: MobileRegressionToolLookupState = "disabled";
        const unresolvedMobileGate =
          mobileRegressionGateState({
            toolLookup: "failed",
            service: ctx.incident.service,
            result: snapshot.result,
          }) === "defer_lookup";

        if (unresolvedMobileGate) {
          try {
            const integrations = await loadEnabledIntegrationsForOrg(ctx.project.orgId);
            toolLookup = hasRevylCreateTestIntegration(integrations) ? "enabled" : "disabled";
          } catch (err) {
            toolLookup = "failed";
            logger.error(
              { err, orgId: ctx.project.orgId },
              "failed to load integrations for result repair gate",
            );
          }
        }

        const gateState = mobileRegressionGateState({
          toolLookup,
          service: ctx.incident.service,
          result: snapshot.result,
        });
        if (gateState !== "allow") {
          if (snapshot.status === "terminated") {
            await failAgentRun(
              ctx,
              "terminated_without_result",
              mobileRegressionGateTerminatedSummary(gateState),
              {
                existingResult: snapshot.result,
              },
            );
            return;
          }

          if (
            exceededWallClockBudget({
              startedAt: ctx.agentRun.startedAt,
              now: new Date(),
              maxRuntimeMinutes: ctx.automation.maxRuntimeMinutes,
              awaitingHumanSeconds,
            })
          ) {
            await failAgentRun(
              ctx,
              "wall_clock_timeout",
              mobileRegressionGateFailureSummary(gateState),
              {
                existingResult: snapshot.result,
              },
            );
            return;
          }

          if (gateState === "defer_lookup") {
            return;
          }

          if (snapshot.status === "idle") {
            try {
              await runner.steer(sessionId, mobileRegressionRepairPrompt());
            } catch (err) {
              if (isSessionBusyError(err)) return;
              throw err;
            }
            logger.info(
              {
                agent_run_id: ctx.agentRun.id,
                incident_id: ctx.incident.id,
                provider_session_id: sessionId,
              },
              "steered agent to repair missing mobile regression test decision",
            );
          }
          return;
        }
      }

      const metadataChanged = await applyIncidentMetadataFromResult(ctx, snapshot.result);
      if (metadataChanged) {
        // Refresh ctx.incident so downstream Slack messages and PR titles use
        // the renamed title / new severity rather than the stale snapshot.
        const refreshed = await db.query.incidents.findFirst({
          where: eq(schema.incidents.id, ctx.incident.id),
        });
        if (refreshed) ctx.incident = refreshed;
      }

      if (selectedRepoFullName) {
        await agentRunLifecycle.appendRepoSelectedEvent({
          agentRunId: ctx.agentRun.id,
          selectedRepoFullName,
        });
      }

      // Helper for AI-cost metering. We emit ONLY after the paired DB state
      // transition commits — a transient DB failure leaves the agentRun
      // in its current state, the next tick re-enters this block with the
      // same Anthropic snapshot, and we'd double-count cumulative counters.
      const meterAgentRun = async (outcome: AgentRunOutcome): Promise<void> => {
        await recordAgentRunCompletion({
          orgId: ctx.project.orgId,
          projectId: ctx.project.id,
          incidentId: ctx.incident.id,
          model: snapshot.modelUsage.model,
          callSite: "agent_run",
          usage: snapshot.modelUsage,
          activeSeconds: snapshot.activeSeconds,
          outcome,
          hasPr: outcome === "complete_with_pr",
        });
        // Consume one investigation credit per COMPLETED run (the billable
        // unit). Failed / awaiting_human runs don't burn a credit. Fail-open:
        // recordInvestigation never throws (see investigation-gate.ts).
        if (outcome === "complete_with_pr" || outcome === "complete_no_pr") {
          await investigationGate.recordInvestigation(ctx.project.orgId);
          // Re-check usage after consuming a credit so investigation 50/85/100%
          // thresholds fire promptly. Fire-and-forget; the notifier dedupes.
          void usageNotifier?.notify(ctx.project.orgId);
        }
      };

      if (snapshot.result.state === "awaiting_human") {
        await moveAgentRunToAwaitingHuman(
          ctx,
          snapshot.result.question ?? "Reply in this thread with the missing context.",
          snapshot.result.summary,
        );
        await meterAgentRun("awaiting_human");
        return;
      }

      if (snapshot.result.state === "failed") {
        const reason: schema.AgentRunFailureReason =
          snapshot.result.failureReason ?? "agent_no_findings";
        await failAgentRun(ctx, reason, snapshot.result.summary, {
          existingResult: snapshot.result,
        });
        await meterAgentRun("failed");
        return;
      }

      if (
        !isCompleteInvestigationAllowed(snapshot.result, {
          prPolicy: ctx.prPolicy,
          githubConnected: ctx.githubInstalls.length > 0,
          approvalPromptsEnabled: ctx.approvalPromptsEnabled,
          // No approval-prompt action is registered in the current runtime.
          approvalPromptToolsAvailable: false,
        })
      ) {
        await failAgentRun(
          ctx,
          "sync_failed",
          "Investigation tried to finish while a remediation intervention was still available.",
          { existingResult: snapshot.result },
        );
        await meterAgentRun("failed");
        return;
      }

      if (snapshot.result.state === "complete" && snapshot.result.incidentResolution) {
        // Terminal resolve_incident (multi-PR contract): issues were
        // classified and PRs delivered mid-run; this resolves the incident.
        const hasPr = !!(await db.query.agentPullRequests.findFirst({
          where: eq(schema.agentPullRequests.incidentId, ctx.incident.id),
          columns: { id: true },
        }));
        await completeWithIncidentResolution(ctx, snapshot.result, sessionId, nextRuntimeMinutes);
        await meterAgentRun(hasPr ? "complete_with_pr" : "complete_no_pr");
        return;
      }

      if (snapshot.result.state === "complete") {
        const pr = snapshot.result.pr ?? null;
        if (pr && pr.validationPassed === false) {
          await failAgentRun(ctx, "patch_validation_failed", snapshot.result.summary, {
            existingResult: snapshot.result,
          });
          await meterAgentRun("failed");
          return;
        }
        const merged = await tryMergeAfterAgentRun(
          ctx,
          snapshot.result,
          sessionId,
          nextRuntimeMinutes,
        );
        if (merged) {
          // tryMergeAfterAgentRun commits the terminal state itself; if
          // it succeeds, the agentRun is complete (the merged-incident
          // path implies the result was actionable, treat as complete_no_pr
          // unless a PR was actually opened).
          await meterAgentRun(
            pr?.validationPassed === true ? "complete_with_pr" : "complete_no_pr",
          );
          return;
        }
        const shouldOpenPr =
          !!pr &&
          pr.validationPassed === true &&
          pr.openStatus === "pending" &&
          ctx.prPolicy !== "never";
        if (shouldOpenPr && pr) {
          await completeWithPullRequest(ctx, snapshot.result, pr, sessionId, nextRuntimeMinutes);
          await meterAgentRun("complete_with_pr");
        } else {
          await completeWithoutPullRequest(ctx, snapshot.result, sessionId, nextRuntimeMinutes);
          await meterAgentRun("complete_no_pr");
        }
        return;
      }
    }

    const pendingContextEvents = await db.query.incidentEvents.findMany({
      where: and(
        eq(schema.incidentEvents.agentRunId, ctx.agentRun.id),
        eq(schema.incidentEvents.kind, "incident_context_changed"),
        isNull(schema.incidentEvents.processedAt),
      ),
      orderBy: [desc(schema.incidentEvents.createdAt)],
    });
    const steeredContextOutcome = await steerIdleRunnerWithPendingContext({
      snapshotStatus: snapshot.status,
      pendingContextEvents,
      runner,
      sessionId,
      incidentId: ctx.incident.id,
      markEventsProcessed: async (ids) => {
        await db
          .update(schema.incidentEvents)
          .set({ processedAt: new Date() })
          .where(inArray(schema.incidentEvents.id, ids));
      },
      notifySteered: async (incidentId) => {
        await postIncidentThreadMessage(
          incidentId,
          ":information_source: Investigation updated with new incident context.",
        );
      },
    });
    if (steeredContextOutcome !== "not_applicable") {
      return;
    }

    // Idle with no terminal call but with PRs out for review: a legitimate
    // end state in the multi-PR contract. Park the run — the durable session
    // is resumed by PR comment/merge/close webhooks (or any human message).
    if (snapshot.status === "idle" && !snapshot.result) {
      const openPrs = await db.query.agentPullRequests.findMany({
        where: and(
          eq(schema.agentPullRequests.incidentId, ctx.incident.id),
          eq(schema.agentPullRequests.state, "open"),
        ),
        columns: { url: true },
      });
      if (openPrs.length > 0) {
        const parkedResult = assembleAgentRunResult({
          findings: snapshot.pendingOutcome?.findings ?? null,
          terminal: null,
          actions: snapshot.pendingOutcome?.actions ?? [],
        });
        // Land the turn's findings on the incident before parking, so the
        // dashboard shows them while the run waits. Skipped when the turn
        // recorded no findings — an empty summary must not blank out
        // findings from an earlier turn.
        if (snapshot.pendingOutcome?.findings) {
          await applyIncidentMetadataFromResult(ctx, parkedResult);
        }
        const openPrUrls = openPrs.map((pr) => pr.url);
        const parked = await moveAgentRunToAwaitingEvents(
          ctx,
          parkedResult,
          openPrUrls,
          async () => {
            try {
              const linearTicket = await deliverLinearTicket(ctx, parkedResult, {
                prUrls: [],
              });
              if (!linearTicket) return null;
              await recordFiledLinearTicket(
                ctx,
                {
                  id: linearTicket.ticketId,
                  url: linearTicket.url,
                  createdByAgent: linearTicket.created,
                },
                { identifier: linearTicket.identifier },
              );
              await linkLinearTicketToPullRequests(ctx, linearTicket, openPrUrls);
              return { identifier: linearTicket.identifier, url: linearTicket.url };
            } catch (err) {
              logger.warn(
                {
                  scope: "agent_run.awaiting_events",
                  agent_run_id: ctx.agentRun.id,
                  incident_id: ctx.incident.id,
                  err: err instanceof Error ? err.message : String(err),
                },
                "failed to record or cross-link Linear ticket after parking; continuing",
              );
              return null;
            }
          },
        );
        // A lost park means a concurrent pass owns this turn's conclusion —
        // it also records the usage, so a duplicate here would double-meter.
        if (parked) {
          await recordAgentRunCompletion({
            orgId: ctx.project.orgId,
            projectId: ctx.project.id,
            incidentId: ctx.incident.id,
            model: snapshot.modelUsage.model,
            callSite: "agent_run",
            usage: snapshot.modelUsage,
            activeSeconds: snapshot.activeSeconds,
            outcome: "awaiting_events",
            hasPr: true,
          });
        }
        return;
      }
    }

    // Idle with no result = the model never called a terminal outcome tool
    // this turn. Nudge once per session; if it still won't conclude, the
    // budget backstops above reap the run.
    if (snapshot.status === "idle" && !snapshot.result) {
      // Claim the marker BEFORE steering: concurrent sync passes would
      // otherwise both read no-marker and double-steer. The partial unique
      // index on (agent_run_id, provider_event_id) makes exactly one insert
      // win. If the steer then fails, the one-shot nudge is spent — the
      // wall-clock/runtime backstops still own the run.
      const nudgeEventId = `terminal_nudge:${sessionId}`;
      const claimed = await db
        .insert(schema.incidentEvents)
        .values({
          agentRunId: ctx.agentRun.id,
          kind: "terminal_nudge",
          summary: "Nudged the agent to end its turn with a terminal outcome tool.",
          providerEventId: nudgeEventId,
          processedAt: new Date(),
        })
        .onConflictDoNothing()
        .returning({ id: schema.incidentEvents.id });
      const claimedRow = claimed[0];
      if (claimedRow) {
        // An ambiguous failure on a previous attempt (e.g. a timeout after
        // the message was enqueued) released the claim even though the nudge
        // landed. The delivered nudge is visible in the session's own event
        // stream, so a retry can detect it and keep the claim without
        // steering a duplicate.
        const completeInvestigationAvailable = ctx.prPolicy === "never";
        const nudgePrompt = terminalOutcomeNudgePrompt({ completeInvestigationAvailable });
        const nudgeAlreadyDelivered = snapshot.events.some(
          (event) =>
            event.type === "user.message" &&
            !!event.summary &&
            event.summary.includes(TERMINAL_OUTCOME_NUDGE_MARKER),
        );
        if (!nudgeAlreadyDelivered) {
          try {
            await runner.steer(sessionId, nudgePrompt);
          } catch (err) {
            // Release the claim so a later tick can retry the nudge — a
            // transient steer failure must not permanently spend the one-shot.
            await db
              .delete(schema.incidentEvents)
              .where(eq(schema.incidentEvents.id, claimedRow.id))
              .catch(() => undefined);
            if (isSessionBusyError(err)) {
              // The model is still working (it produced a tool call between
              // our collect pass and this steer) — not idle-stuck at all.
              // Skip; the next tick re-evaluates.
              return;
            }
            throw err;
          }
        }
        logger.info(
          {
            agent_run_id: ctx.agentRun.id,
            incident_id: ctx.incident.id,
            provider_session_id: sessionId,
            redelivery_skipped: nudgeAlreadyDelivered,
          },
          "steered idle agent to call a terminal outcome tool",
        );
        return;
      }
    }

    if (snapshot.status === "terminated" && !snapshot.result) {
      await failAgentRun(
        ctx,
        "terminated_without_result",
        "Managed agent run terminated without a structured result.",
      );
    }
  } catch (err) {
    if (isTransientError(err)) {
      // A run whose provider session has gone permanently unreachable (e.g. a
      // session abandoned across a deploy, or one Anthropic has since reaped)
      // throws a transient-shaped error — timeout / connection reset / 5xx —
      // on EVERY collect(). Left alone it retries forever and sits in
      // `running` indefinitely (weeks, in prod), holding a slot in the active
      // set that the tick rotates through on every pass. The wall-clock
      // backstop above can't catch these: it lives past the collect() call
      // that's throwing. So apply the same budget here — once a run has blown
      // its wall-clock budget, stop retrying transient failures and reap it.
      if (
        exceededWallClockBudget({
          startedAt: ctx.agentRun.startedAt,
          now: new Date(),
          maxRuntimeMinutes: ctx.automation.maxRuntimeMinutes,
          awaitingHumanSeconds,
        })
      ) {
        await failAgentRun(
          ctx,
          "wall_clock_timeout",
          "Investigation exceeded its wall-clock budget while its managed session stayed unreachable.",
          { err },
        );
        return;
      }
      logger.error(
        {
          err,
          scope: "agent_run",
          agent_run_id: ctx.agentRun.id,
          incident_id: ctx.incident.id,
          project_id: ctx.project.id,
          org_id: ctx.project.orgId,
          provider_session_id: sessionId,
          stage: "sync",
        },
        "agent run sync hit transient error; will retry on next tick",
      );
      return;
    }
    await failAgentRun(ctx, "sync_failed", "Investigation sync failed.", {
      err,
    });
  }
}
