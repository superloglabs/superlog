import {
  type AgentPullRequestLifecycleContinuation,
  type AgentPullRequestLifecycleRecord,
  type AgentRunResult,
  INBOUND_INTERACTION_EVENT_KINDS,
  areAllIncidentPullRequestsMerged,
  areAllIncidentPullRequestsSettled,
  buildAgentPullRequestLifecycleContinuation,
  db,
  latestAgentPullRequestSettlementAt,
  recordInboundInteraction,
  resolveIncidentIfAllAgentPullRequestsMerged,
  resolveIncidentIfAllAgentPullRequestsSettled,
  schema,
} from "@superlog/db";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { TERMINAL_OUTCOME_NUDGE_MARKER, assembleAgentRunResult } from "../agent-outcome-tools.js";
import type { AgentRunContext } from "../agent-run-context.js";
import { listAccessibleGithubRepositories } from "../agent-run-context.js";
import { type PauseForEventsOutcome, createAgentRunLifecycle } from "../agent-run.js";
import type { AgentRunnerSnapshot } from "../agent-runner-backend.js";
import { type AgentRunOutcome, recordAgentRunCompletion } from "../ai-usage.js";
import { investigationGate } from "../billing/investigation-gate.js";
import { usageNotifier } from "../billing/usage-notifier-infra.js";
import { getAgentRunnerBackend } from "../infra/agent-runner/backend.js";
import { createRepositoryReadToken } from "../infra/github/repositories.js";
import { postIncidentThreadMessage } from "../infra/slack/incident-messages.js";
import { type ResolvedIntegration, loadEnabledIntegrationsForOrg } from "../integrations.js";
import { logger } from "../logger.js";
import { completeWithIncidentResolution, completeWithoutPullRequest } from "./completion.js";
import {
  PULL_REQUEST_DELIVERY_EVENT_KIND,
  pullRequestDeliveryUrlFromReceiptDetail,
} from "./deliverable-records.js";
import { scheduleLinearHandoff } from "./linear-handoff.js";
import { tryMergeAfterAgentRun } from "./merge.js";
import { hasRevylCreateTestIntegration, looksLikeMobileChange } from "./mobile-regression.js";
import { createOutcomeActionExecutor } from "./outcome-actions.js";
import { completeWithPullRequest, resolvePullRequestBaseBranch } from "./pr-delivery.js";
import {
  type DeliveredPullRequestRecord,
  reconcileDeliveredPullRequests,
  selectDeliveredPullRequestsForOutcome,
} from "./pr-result-reconciliation.js";
import { reclaimStaleRecoveryClaim, recoverExhaustedRunnerTurn } from "./recovery.js";
import { supersededSnapshotCompletionResult } from "./resolution-completion.js";
import {
  awaitingHumanSecondsFromEvents,
  exceededWallClockBudget,
  failAgentRun,
  isTransientError,
  moveAgentRunToAwaitingEvents,
  moveAgentRunToAwaitingHuman,
} from "./status.js";

export { hasRevylCreateTestIntegration } from "./mobile-regression.js";

export async function meterAgentRunCompletionIfClaimed(
  claimed: boolean,
  meter: () => Promise<void>,
): Promise<boolean> {
  if (!claimed) return false;
  await meter();
  return true;
}

export function shouldFailForRuntimeBudget(args: {
  activeRuntimeMinutes: number;
  maxRuntimeMinutes: number;
  hasResult: boolean;
}): boolean {
  return !args.hasResult && args.activeRuntimeMinutes >= args.maxRuntimeMinutes;
}

export function planPullRequestAwaitingEvents<
  PullRequest extends { state: schema.AgentPrState; url: string },
>(
  result: AgentRunResult,
  deliveredPullRequests: PullRequest[],
): {
  shouldFail: boolean;
  openPrUrls: string[];
  settledPullRequests: PullRequest[];
} {
  const isExternalCause = result.waitReason === "external_cause";
  const openPrUrls = deliveredPullRequests
    .filter((pullRequest) => pullRequest.state === "open")
    .map((pullRequest) => pullRequest.url);
  return {
    shouldFail: !isExternalCause && deliveredPullRequests.length === 0,
    openPrUrls,
    settledPullRequests: isExternalCause
      ? []
      : deliveredPullRequests.filter((pullRequest) => pullRequest.state !== "open"),
  };
}

export type AwaitingEventsTransitionPlan =
  | { kind: "parked" }
  | { kind: "skip" }
  | {
      kind: "complete";
      incidentStatus: schema.IncidentStatus | null;
      result: AgentRunResult;
    };

export function planAwaitingEventsTransition(
  result: AgentRunResult,
  outcome: PauseForEventsOutcome,
): AwaitingEventsTransitionPlan {
  if (outcome.kind === "parked") return { kind: "parked" };
  if (outcome.kind === "run_not_running") return { kind: "skip" };
  return {
    kind: "complete",
    incidentStatus: outcome.incidentStatus,
    result: { ...result, state: "complete" },
  };
}

export function isCompleteInvestigationAllowed(
  result: AgentRunResult,
  capabilities: {
    prPolicy: schema.PrPolicy;
    githubConnected: boolean;
  },
): boolean {
  if (result.completionKind !== "investigation_complete") return true;
  // Pre-cutover sessions persisted this flag for the provider-specific handoff
  // terminal. Let those immutable snapshots drain even when PR creation would
  // block a newly declared complete_investigation call.
  if (result.linearTicketRequested) return true;
  const prCreation = capabilities.githubConnected && capabilities.prPolicy !== "never";
  return !prCreation;
}

export function completeInvestigationAvailable(capabilities: {
  prPolicy: schema.PrPolicy;
  githubConnected: boolean;
}): boolean {
  const prCreation = capabilities.githubConnected && capabilities.prPolicy !== "never";
  return !prCreation;
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

export type SettledPullRequestLifecycle = AgentPullRequestLifecycleRecord;

export type SettledPullRequestContinuationOutcome =
  | "steered"
  | "busy"
  | "deferred"
  | "terminated"
  | "unavailable"
  | "not_applicable";

export type PullRequestLifecycleRecordOutcome = "recorded" | "duplicate" | "unavailable";

export type SettledPullRequestFallbackPlan =
  | { kind: "resolve_merged"; pullRequest: SettledPullRequestLifecycle }
  | { kind: "resolve_settled"; pullRequest: SettledPullRequestLifecycle }
  | { kind: "follow_up" };

export function planSettledPullRequestFallback(
  settledPullRequests: SettledPullRequestLifecycle[],
  incidentPullRequests: SettledPullRequestLifecycle[],
): SettledPullRequestFallbackPlan {
  const mergedPullRequest = settledPullRequests.find(
    (pullRequest) => pullRequest.state === "merged",
  );
  if (mergedPullRequest && areAllIncidentPullRequestsMerged(incidentPullRequests)) {
    return { kind: "resolve_merged", pullRequest: mergedPullRequest };
  }
  // Any settle event (merge or close) with no delivery left in play resolves
  // the incident — on a mixed incident the merge can be the last event, and
  // no later close will arrive to trigger the policy. Attribution — crediting
  // a merged sibling over the close — is decided later, on the resolver's
  // locked PR snapshot.
  const settledPullRequest =
    mergedPullRequest ?? settledPullRequests.find((pullRequest) => pullRequest.state === "closed");
  if (settledPullRequest && areAllIncidentPullRequestsSettled(incidentPullRequests)) {
    return { kind: "resolve_settled", pullRequest: settledPullRequest };
  }
  return { kind: "follow_up" };
}

// A durable provider session can resume for several turns while retaining the
// same AgentRun id. Delivery receipts recover a partial batch only within the
// current turn: receipts older than the latest `resumed` event belong to an
// earlier terminal outcome and must not pull its settled PR into this one.
export function selectDeliveredPullRequestsForCurrentTurn<
  PullRequest extends DeliveredPullRequestRecord,
>(
  result: AgentRunResult,
  deliveredPullRequests: PullRequest[],
  currentAgentRunId: string,
  deliveryReceiptEvents: Array<{
    detail: Record<string, unknown> | null;
    createdAt: Date;
  }>,
  latestResumedAt: Date | null,
): PullRequest[] {
  const cutoff = latestResumedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const deliveryReceiptUrls = deliveryReceiptEvents.flatMap(({ detail, createdAt }) => {
    if (createdAt.getTime() < cutoff) return [];
    const url = pullRequestDeliveryUrlFromReceiptDetail(detail);
    return url ? [url] : [];
  });
  return selectDeliveredPullRequestsForOutcome(result, deliveredPullRequests, currentAgentRunId, {
    deliveryReceiptUrls,
  });
}

export async function continueSettledPullRequestLifecycle(opts: {
  snapshotStatus: string;
  settledPullRequests: SettledPullRequestLifecycle[];
  now: Date;
  recordInteraction(
    continuation: AgentPullRequestLifecycleContinuation,
  ): Promise<PullRequestLifecycleRecordOutcome>;
  loadPendingContextEvents(): Promise<PendingContextEvent[]>;
  runner: { steer(sessionId: string, message: string): Promise<void> };
  sessionId: string;
  incidentId: string;
  markEventsProcessed(ids: string[]): Promise<void>;
  notifySteered(incidentId: string): Promise<void>;
}): Promise<SettledPullRequestContinuationOutcome> {
  const continuations = opts.settledPullRequests.flatMap((pullRequest) => {
    const continuation = buildAgentPullRequestLifecycleContinuation({
      pullRequest,
      fallbackOccurredAt: opts.now,
    });
    return continuation ? [continuation] : [];
  });
  if (continuations.length === 0) return "not_applicable";
  if (opts.snapshotStatus === "terminated") return "terminated";

  const recordOutcomes: PullRequestLifecycleRecordOutcome[] = [];
  for (const continuation of continuations) {
    recordOutcomes.push(await opts.recordInteraction(continuation));
  }
  const pendingContextEvents = await opts.loadPendingContextEvents();
  const steerOutcome = await steerIdleRunnerWithPendingContext({
    snapshotStatus: opts.snapshotStatus,
    pendingContextEvents,
    runner: opts.runner,
    sessionId: opts.sessionId,
    incidentId: opts.incidentId,
    markEventsProcessed: opts.markEventsProcessed,
    notifySteered: opts.notifySteered,
  });
  if (steerOutcome !== "not_applicable") return steerOutcome;
  return recordOutcomes.every((outcome) => outcome === "unavailable") ? "unavailable" : "deferred";
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
    prCreationAvailable?: boolean;
  } = {},
): string {
  const terminalTools: string[] = [];
  const prCreationAvailable = args.prCreationAvailable ?? !args.completeInvestigationAvailable;
  if (prCreationAvailable) terminalTools.push("batched `propose_pr`");
  if (args.completeInvestigationAvailable) terminalTools.push("`complete_investigation`");
  terminalTools.push(
    "`resolve_incident` with all Issue outcomes",
    "`report_external_cause`",
    "`ask_human`",
  );
  return [
    TERMINAL_OUTCOME_NUDGE_MARKER,
    `Call \`report_findings\` now if you have findings to record, then end the turn with exactly one terminal tool: ${terminalTools.join(", ")}.`,
  ].join("\n");
}

export function terminalOutcomeNudgeCapabilities(
  snapshot: Partial<Pick<AgentRunnerSnapshot, "declaredCustomToolNames">>,
  fallback: {
    prCreationAvailable: boolean;
    completeInvestigationAvailable: boolean;
  },
): {
  prCreationAvailable: boolean;
  completeInvestigationAvailable: boolean;
} {
  const declared = snapshot.declaredCustomToolNames;
  if (!declared) {
    logger.info(
      {
        scope: "agent_run.nudge",
        fallback_capabilities: fallback,
      },
      "terminal outcome nudge is using legacy snapshot capabilities",
    );
    return fallback;
  }
  const names = new Set(declared);
  return {
    prCreationAvailable: names.has("propose_pr"),
    completeInvestigationAvailable: names.has("complete_investigation"),
  };
}

const PARTIAL_PULL_REQUEST_RETRY_NUDGE_MARKER = "[superlog:partial-pull-request-retry-nudge]";

export function partialPullRequestRetryNudgePrompt(pendingRepoFullNames: string[]): string {
  return [
    TERMINAL_OUTCOME_NUDGE_MARKER,
    `${PARTIAL_PULL_REQUEST_RETRY_NUDGE_MARKER} ${JSON.stringify(pendingRepoFullNames)}`,
    `Retry \`propose_pr\` now with exactly these pending repositories: ${pendingRepoFullNames.join(
      ", ",
    )}. Do not repeat repositories that were already delivered.`,
  ].join("\n");
}

export function shouldParkCompatibilityPullRequests(args: {
  openPullRequestCount: number;
  blockingPullRequestDeliveryKind:
    | "retry_required"
    | "incident_not_open"
    | "manual_reconciliation_required"
    | null;
}): boolean {
  return args.openPullRequestCount > 0 && args.blockingPullRequestDeliveryKind === null;
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
    if (
      shouldFailForRuntimeBudget({
        activeRuntimeMinutes: nextRuntimeMinutes,
        maxRuntimeMinutes: ctx.automation.maxRuntimeMinutes,
        hasResult: snapshot.result !== null,
      })
    ) {
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

    // Emit AI-cost metering only after the paired DB state transition commits.
    // A transient failure leaves the AgentRun in its current state, so a later
    // tick can retry without double-counting cumulative provider usage.
    const meterAgentRun = async (
      outcome: AgentRunOutcome,
      hasPr = outcome === "complete_with_pr",
    ): Promise<void> => {
      await recordAgentRunCompletion({
        orgId: ctx.project.orgId,
        projectId: ctx.project.id,
        incidentId: ctx.incident.id,
        model: snapshot.modelUsage.model,
        callSite: "agent_run",
        usage: snapshot.modelUsage,
        activeSeconds: snapshot.activeSeconds,
        outcome,
        hasPr,
      });
      if (outcome === "complete_with_pr" || outcome === "complete_no_pr") {
        await investigationGate.recordInvestigation(ctx.project.orgId);
        void usageNotifier?.notify(ctx.project.orgId);
      }
    };
    const reconcileTerminalSnapshotAfterResolution = (result: AgentRunResult) =>
      agentRunLifecycle.reconcileCompletedByResolution({
        id: ctx.agentRun.id,
        result: supersededSnapshotCompletionResult(result),
        cumulativeRuntimeMinutes: nextRuntimeMinutes,
        lastSyncedAt: new Date(),
      });

    const syncedAt = new Date();
    const baseUpdate: Partial<schema.AgentRun> = {
      providerSessionStatus: snapshot.status,
      cumulativeRuntimeMinutes: nextRuntimeMinutes,
      lastSyncedAt: syncedAt,
      updatedAt: syncedAt,
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
    const snapshotRecorded = await agentRunLifecycle.recordCollectedSnapshotIfCurrent({
      id: ctx.agentRun.id,
      incidentId: ctx.incident.id,
      currentState: ctx.agentRun.state,
      updates: baseUpdate,
    });
    if (!snapshotRecorded) {
      if (!snapshot.result) return;
      const reconciled = await agentRunLifecycle.reconcileCompletedByResolution({
        id: ctx.agentRun.id,
        result: supersededSnapshotCompletionResult(snapshot.result),
        cumulativeRuntimeMinutes: nextRuntimeMinutes,
        lastSyncedAt: syncedAt,
        selectedRepoFullName,
        selectedBaseBranch: baseBranch,
      });
      if (reconciled) {
        const hasPr = !!(await db.query.agentPullRequests.findFirst({
          where: eq(schema.agentPullRequests.incidentId, ctx.incident.id),
          columns: { id: true },
        }));
        await meterAgentRun(hasPr ? "complete_with_pr" : "complete_no_pr", hasPr);
      }
      return;
    }

    if (!snapshot.result && snapshot.recoverableFailure) {
      try {
        const recovery = await recoverExhaustedRunnerTurn({
          sessionId,
          failure: snapshot.recoverableFailure,
          runner,
          listRepositories: async () =>
            (await listAccessibleGithubRepositories(ctx)).map((repository) => ({
              fullName: repository.fullName,
              id: repository.id,
              installationId: repository.installation.installationId,
            })),
          createRepositoryReadToken,
          claimRecovery: async (providerEventId) => {
            const recoveryEventId = `session_recovery:${providerEventId}`;
            const insertClaim = () =>
              db
                .insert(schema.incidentEvents)
                .values({
                  agentRunId: ctx.agentRun.id,
                  kind: "session_recovery",
                  summary:
                    "Refreshing repository access and continuing after the managed service exhausted its retries.",
                  providerEventId: recoveryEventId,
                })
                .onConflictDoNothing()
                .returning({ id: schema.incidentEvents.id });
            const inserted = await insertClaim();
            if (inserted[0]) return inserted[0];

            // An unprocessed claim is a lease, not a permanent lock. If its
            // owner crashed (or failed to delete it after a recovery error),
            // a later sync pass may reclaim it. Completed claims retain
            // processed_at and continue to deduplicate the provider event.
            const staleClaim = await db.query.incidentEvents.findFirst({
              where: and(
                eq(schema.incidentEvents.agentRunId, ctx.agentRun.id),
                eq(schema.incidentEvents.providerEventId, recoveryEventId),
              ),
              columns: { id: true, createdAt: true, processedAt: true },
            });
            if (!staleClaim) return null;
            return reclaimStaleRecoveryClaim({
              staleClaim,
              now: new Date(),
              deleteIfStillUnprocessed: async (id) => {
                const deleted = await db
                  .delete(schema.incidentEvents)
                  .where(
                    and(
                      eq(schema.incidentEvents.id, id),
                      isNull(schema.incidentEvents.processedAt),
                    ),
                  )
                  .returning({ id: schema.incidentEvents.id });
                return !!deleted[0];
              },
              insertReplacement: async () => (await insertClaim())[0] ?? null,
            });
          },
          releaseRecoveryClaim: async (id) => {
            await db
              .delete(schema.incidentEvents)
              .where(
                and(eq(schema.incidentEvents.id, id), isNull(schema.incidentEvents.processedAt)),
              );
          },
          completeRecoveryClaim: async (id) => {
            await db
              .update(schema.incidentEvents)
              .set({ processedAt: new Date() })
              .where(eq(schema.incidentEvents.id, id));
          },
        });
        logger.info(
          {
            agent_run_id: ctx.agentRun.id,
            incident_id: ctx.incident.id,
            provider_session_id: sessionId,
            provider_event_id: snapshot.recoverableFailure.providerEventId,
            recovery,
          },
          "handled exhausted managed-agent turn",
        );
      } catch (err) {
        logger.warn(
          {
            err,
            agent_run_id: ctx.agentRun.id,
            incident_id: ctx.incident.id,
            provider_session_id: sessionId,
          },
          "managed-agent turn recovery failed; leaving it retryable",
        );
      }
      return;
    }

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
        inArray(schema.incidentEvents.kind, [...INBOUND_INTERACTION_EVENT_KINDS]),
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
            const failed = await failAgentRun(
              ctx,
              "terminated_without_result",
              mobileRegressionGateTerminatedSummary(gateState),
              {
                existingResult: snapshot.result,
              },
            );
            if (failed) {
              await meterAgentRun("failed");
            } else if (await reconcileTerminalSnapshotAfterResolution(snapshot.result)) {
              await meterAgentRun("complete_no_pr");
            }
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
            const failed = await failAgentRun(
              ctx,
              "wall_clock_timeout",
              mobileRegressionGateFailureSummary(gateState),
              {
                existingResult: snapshot.result,
              },
            );
            if (failed) {
              await meterAgentRun("failed");
            } else if (await reconcileTerminalSnapshotAfterResolution(snapshot.result)) {
              await meterAgentRun("complete_no_pr");
            }
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

      if (selectedRepoFullName) {
        await agentRunLifecycle.appendRepoSelectedEvent({
          agentRunId: ctx.agentRun.id,
          selectedRepoFullName,
        });
      }

      if (snapshot.result.state === "awaiting_human") {
        const paused = await moveAgentRunToAwaitingHuman(
          ctx,
          snapshot.result.question ?? "Reply in this thread with the missing context.",
          snapshot.result.summary,
          snapshot.result,
        );
        if (paused) {
          await meterAgentRun("awaiting_human");
        } else if (await reconcileTerminalSnapshotAfterResolution(snapshot.result)) {
          await meterAgentRun("complete_no_pr");
        }
        return;
      }

      if (snapshot.result.state === "failed") {
        const reason: schema.AgentRunFailureReason =
          snapshot.result.failureReason ?? "agent_no_findings";
        const failed = await failAgentRun(ctx, reason, snapshot.result.summary, {
          existingResult: snapshot.result,
        });
        if (failed) {
          await meterAgentRun("failed");
        } else if (await reconcileTerminalSnapshotAfterResolution(snapshot.result)) {
          await meterAgentRun("complete_no_pr");
        }
        return;
      }

      if (snapshot.result.state === "awaiting_events") {
        const [deliveredPrs, deliveryReceiptEvents, latestResumedEvent] = await Promise.all([
          db.query.agentPullRequests.findMany({
            where: eq(schema.agentPullRequests.incidentId, ctx.incident.id),
            columns: {
              id: true,
              agentRunId: true,
              repoFullName: true,
              branchName: true,
              baseBranch: true,
              prNumber: true,
              title: true,
              url: true,
              state: true,
              mergedAt: true,
              closedAt: true,
              mergedByLogin: true,
              createdAt: true,
            },
            orderBy: [asc(schema.agentPullRequests.createdAt), asc(schema.agentPullRequests.id)],
          }),
          db.query.incidentEvents.findMany({
            where: and(
              eq(schema.incidentEvents.incidentId, ctx.incident.id),
              eq(schema.incidentEvents.agentRunId, ctx.agentRun.id),
              eq(schema.incidentEvents.kind, PULL_REQUEST_DELIVERY_EVENT_KIND),
            ),
            columns: { detail: true, createdAt: true },
          }),
          db.query.incidentEvents.findFirst({
            where: and(
              eq(schema.incidentEvents.incidentId, ctx.incident.id),
              eq(schema.incidentEvents.agentRunId, ctx.agentRun.id),
              eq(schema.incidentEvents.kind, "resumed"),
            ),
            columns: { createdAt: true },
            orderBy: [desc(schema.incidentEvents.createdAt), desc(schema.incidentEvents.id)],
          }),
        ]);
        // A failed batch can deliver some repositories before the model
        // retries only the remaining entries. The final tool result therefore
        // does not necessarily name every mutation from this run. Durable
        // per-delivery receipts retain those earlier URLs, including updates
        // to canonical PR rows originally created by another run.
        const outcomePrs = selectDeliveredPullRequestsForCurrentTurn(
          snapshot.result,
          deliveredPrs,
          ctx.agentRun.id,
          deliveryReceiptEvents,
          latestResumedEvent?.createdAt ?? null,
        );
        const waitPlan = planPullRequestAwaitingEvents(snapshot.result, outcomePrs);
        if (waitPlan.shouldFail) {
          const failed = await failAgentRun(
            ctx,
            "sync_failed",
            "A PR outcome finished without a recorded delivered PR.",
            { existingResult: snapshot.result },
          );
          if (failed) {
            await meterAgentRun("failed");
          } else if (await reconcileTerminalSnapshotAfterResolution(snapshot.result)) {
            await meterAgentRun("complete_no_pr");
          }
          return;
        }

        const reconciledResult = reconcileDeliveredPullRequests(snapshot.result, outcomePrs, {
          currentAgentRunId: ctx.agentRun.id,
        });
        if (waitPlan.settledPullRequests.length > 0) {
          const continuationOutcome = await continueSettledPullRequestLifecycle({
            snapshotStatus: snapshot.status,
            settledPullRequests: waitPlan.settledPullRequests,
            now: new Date(),
            recordInteraction: async (continuation) => {
              const recorded = await recordInboundInteraction(db, {
                incidentId: ctx.incident.id,
                interaction: continuation.interaction,
                dedupeKey: continuation.dedupeKey,
                confirmed: true,
              });
              if (recorded.outcome === "skipped") return "unavailable";
              return recorded.outcome === "duplicate" ? "duplicate" : "recorded";
            },
            loadPendingContextEvents: () =>
              db.query.incidentEvents.findMany({
                where: and(
                  eq(schema.incidentEvents.agentRunId, ctx.agentRun.id),
                  inArray(schema.incidentEvents.kind, [...INBOUND_INTERACTION_EVENT_KINDS]),
                  isNull(schema.incidentEvents.processedAt),
                ),
                orderBy: [asc(schema.incidentEvents.createdAt)],
              }),
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
          if (continuationOutcome !== "terminated" && continuationOutcome !== "unavailable") {
            return;
          }

          const fallback = planSettledPullRequestFallback(
            waitPlan.settledPullRequests,
            deliveredPrs,
          );
          if (fallback.kind === "resolve_merged" || fallback.kind === "resolve_settled") {
            const settledAt =
              fallback.pullRequest.mergedAt ?? fallback.pullRequest.closedAt ?? new Date();
            const eventDedupeKey =
              fallback.kind === "resolve_merged"
                ? `incident_resolved:agent_pr:${fallback.pullRequest.id}`
                : `incident_resolved:agent_pr_closed:${fallback.pullRequest.id}:${settledAt.getTime()}`;
            const resolution =
              fallback.kind === "resolve_merged"
                ? await resolveIncidentIfAllAgentPullRequestsMerged({
                    incidentId: ctx.incident.id,
                    kind: "agent_pr_merged",
                    reasonCode: "agent_pr_merged",
                    reasonText: `Resolved because agent PR #${fallback.pullRequest.prNumber} (${fallback.pullRequest.repoFullName}) was merged${
                      fallback.pullRequest.mergedByLogin
                        ? ` by @${fallback.pullRequest.mergedByLogin}`
                        : ""
                    }.`,
                    agentRunId: ctx.agentRun.id,
                    eventSummary: `Incident resolved because PR #${fallback.pullRequest.prNumber} was merged.`,
                    eventDetail: {
                      agentPrId: fallback.pullRequest.id,
                      repoFullName: fallback.pullRequest.repoFullName,
                      prNumber: fallback.pullRequest.prNumber,
                      prUrl: fallback.pullRequest.url,
                      mergedByLogin: fallback.pullRequest.mergedByLogin,
                    },
                    eventDedupeKey,
                    resolvedAt: settledAt,
                  })
                : await resolveIncidentIfAllAgentPullRequestsSettled({
                    incidentId: ctx.incident.id,
                    settlementEvidenceAt: settledAt,
                    // Attribution comes from the locked PR snapshot: credit a
                    // merged sibling when one landed in the current epoch,
                    // otherwise resolve as a plain close — a PR merged before
                    // the incident's last manual reopen is a fix the human
                    // already overrode.
                    buildInput: (lockedPullRequests, epoch) => {
                      const mergedSibling =
                        lockedPullRequests
                          .filter(
                            (pullRequest) =>
                              pullRequest.state === "merged" &&
                              pullRequest.mergedAt &&
                              (!epoch.reopenedAt ||
                                pullRequest.mergedAt.getTime() > epoch.reopenedAt.getTime()),
                          )
                          .sort(
                            (a, b) => (a.mergedAt?.getTime() ?? 0) - (b.mergedAt?.getTime() ?? 0),
                          )
                          .at(-1) ?? null;
                      // The delivery finished at the latest settle across the
                      // snapshot — stamping the closed PR's time when the fix
                      // merged later would backdate the resolution.
                      const resolvedAt =
                        latestAgentPullRequestSettlementAt(lockedPullRequests) ?? settledAt;
                      // Trigger-agnostic wording: the settle event that fired
                      // this plan can itself be the merge.
                      return mergedSibling
                        ? {
                            incidentId: ctx.incident.id,
                            kind: "agent_pr_merged" as const,
                            reasonCode: "agent_pr_merged",
                            reasonText: `Resolved because agent PR #${mergedSibling.prNumber} (${mergedSibling.repoFullName}) was merged and the remaining agent PRs were closed without merge.`,
                            agentRunId: ctx.agentRun.id,
                            eventSummary: `Incident resolved: fix PR #${mergedSibling.prNumber} is merged and the remaining agent PRs are closed.`,
                            eventDetail: {
                              agentPrId: fallback.pullRequest.id,
                              repoFullName: fallback.pullRequest.repoFullName,
                              prNumber: fallback.pullRequest.prNumber,
                              prUrl: fallback.pullRequest.url,
                              mergedAgentPrId: mergedSibling.id,
                              mergedPrNumber: mergedSibling.prNumber,
                            },
                            eventDedupeKey,
                            resolvedAt,
                          }
                        : {
                            incidentId: ctx.incident.id,
                            kind: "agent_pr_closed" as const,
                            reasonCode: "agent_pr_closed",
                            reasonText: `Resolved because agent PR #${fallback.pullRequest.prNumber} (${fallback.pullRequest.repoFullName}) was closed without merge and no agent PRs remain open.`,
                            agentRunId: ctx.agentRun.id,
                            eventSummary: `Incident resolved because PR #${fallback.pullRequest.prNumber} was closed without merge.`,
                            eventDetail: {
                              agentPrId: fallback.pullRequest.id,
                              repoFullName: fallback.pullRequest.repoFullName,
                              prNumber: fallback.pullRequest.prNumber,
                              prUrl: fallback.pullRequest.url,
                            },
                            eventDedupeKey,
                            resolvedAt,
                          };
                    },
                  });
            if (resolution.disposition === "resolved") {
              const completed = await completeWithoutPullRequest(
                ctx,
                { ...reconciledResult, state: "complete" },
                sessionId,
                nextRuntimeMinutes,
                {
                  incidentOutcome:
                    fallback.kind === "resolve_merged"
                      ? {
                          kind: "all_pull_requests_merged",
                          prNumber: fallback.pullRequest.prNumber,
                          repoFullName: fallback.pullRequest.repoFullName,
                          resolutionProof: {
                            agentRunId: ctx.agentRun.id,
                            eventDedupeKey,
                          },
                        }
                      : {
                          kind: "all_pull_requests_settled",
                          prNumber: fallback.pullRequest.prNumber,
                          repoFullName: fallback.pullRequest.repoFullName,
                          settledState:
                            fallback.pullRequest.state === "merged" ? "merged" : "closed",
                          resolutionProof: {
                            agentRunId: ctx.agentRun.id,
                            eventDedupeKey,
                          },
                        },
                },
              );
              if (completed) await meterAgentRun("complete_with_pr");
              return;
            }
            if (resolution.disposition === "incident_not_open") {
              const completed = await completeWithoutPullRequest(
                ctx,
                { ...reconciledResult, state: "complete" },
                sessionId,
                nextRuntimeMinutes,
                { incidentOutcome: { kind: "incident_already_closed" } },
              );
              if (completed) await meterAgentRun("complete_with_pr");
              return;
            }
          }

          const interactions = waitPlan.settledPullRequests.flatMap((pullRequest) => {
            const continuation = buildAgentPullRequestLifecycleContinuation({
              pullRequest,
              fallbackOccurredAt: new Date(),
            });
            return continuation ? [continuation.interaction] : [];
          });
          const handoff = await agentRunLifecycle.handoffTerminatedSessionToFollowUp({
            id: ctx.agentRun.id,
            incidentId: ctx.incident.id,
            currentState: ctx.agentRun.state,
            runtime: ctx.agentRun.runtime,
            interactions,
            existingResult: reconciledResult,
          });
          if (handoff.kind === "enqueued") {
            logger.info(
              {
                agent_run_id: ctx.agentRun.id,
                follow_up_agent_run_id: handoff.agentRunId,
                incident_id: ctx.incident.id,
                settled_pull_request_count: waitPlan.settledPullRequests.length,
              },
              "queued pull request lifecycle follow-up after the provider session ended",
            );
          } else if (handoff.kind === "incident_not_open") {
            const completed = await completeWithoutPullRequest(
              ctx,
              { ...reconciledResult, state: "complete" },
              sessionId,
              nextRuntimeMinutes,
            );
            if (completed) await meterAgentRun("complete_with_pr");
          }
          return;
        }
        const parkOutcome = await moveAgentRunToAwaitingEvents(
          ctx,
          reconciledResult,
          waitPlan.openPrUrls,
          waitPlan.openPrUrls.length === 0
            ? undefined
            : async () => {
                const linearTicket = await scheduleLinearHandoff(
                  ctx,
                  reconciledResult,
                  `awaiting_events:${waitPlan.openPrUrls.join(",")}`,
                );
                return linearTicket
                  ? { identifier: linearTicket.identifier, url: linearTicket.url }
                  : null;
              },
        );
        const transition = planAwaitingEventsTransition(reconciledResult, parkOutcome);
        if (transition.kind === "complete") {
          const completed = await agentRunLifecycle.completeWithoutPullRequest({
            id: ctx.agentRun.id,
            currentState: ctx.agentRun.state,
            result: transition.result,
            providerSessionIdToTerminate: sessionId,
          });
          if (completed) {
            await meterAgentRun(
              outcomePrs.length > 0 ? "complete_with_pr" : "complete_no_pr",
              outcomePrs.length > 0,
            );
          }
          return;
        }
        if (transition.kind === "parked") {
          await meterAgentRun("awaiting_events", waitPlan.openPrUrls.length > 0);
        } else if (
          transition.kind === "skip" &&
          (await reconcileTerminalSnapshotAfterResolution(reconciledResult))
        ) {
          await meterAgentRun(
            outcomePrs.length > 0 ? "complete_with_pr" : "complete_no_pr",
            outcomePrs.length > 0,
          );
        }
        return;
      }

      if (
        !isCompleteInvestigationAllowed(snapshot.result, {
          prPolicy: ctx.prPolicy,
          githubConnected: ctx.githubInstalls.length > 0,
        })
      ) {
        const failed = await failAgentRun(
          ctx,
          "sync_failed",
          "Investigation tried to finish without a pull request while PR creation was still available.",
          { existingResult: snapshot.result },
        );
        if (failed) {
          await meterAgentRun("failed");
        } else if (await reconcileTerminalSnapshotAfterResolution(snapshot.result)) {
          await meterAgentRun("complete_no_pr");
        }
        return;
      }

      if (snapshot.result.state === "complete" && snapshot.result.incidentResolution) {
        // The successful terminal ack means resolve_incident already committed
        // every Issue outcome and the Incident resolution atomically. This
        // path persists the run result and reconciles dependent deliverables.
        const hasPr = !!(await db.query.agentPullRequests.findFirst({
          where: eq(schema.agentPullRequests.incidentId, ctx.incident.id),
          columns: { id: true },
        }));
        const completed = await completeWithIncidentResolution(
          ctx,
          snapshot.result,
          sessionId,
          nextRuntimeMinutes,
        );
        if (completed) await meterAgentRun(hasPr ? "complete_with_pr" : "complete_no_pr");
        return;
      }

      if (snapshot.result.state === "complete") {
        const pr = snapshot.result.pr ?? null;
        if (pr && pr.validationPassed === false) {
          const failed = await failAgentRun(
            ctx,
            "patch_validation_failed",
            snapshot.result.summary,
            {
              existingResult: snapshot.result,
            },
          );
          if (failed) {
            await meterAgentRun("failed");
          } else if (await reconcileTerminalSnapshotAfterResolution(snapshot.result)) {
            await meterAgentRun("complete_no_pr");
          }
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
          const completed = await completeWithPullRequest(
            ctx,
            snapshot.result,
            pr,
            sessionId,
            nextRuntimeMinutes,
          );
          await meterAgentRunCompletionIfClaimed(completed, () =>
            meterAgentRun("complete_with_pr"),
          );
        } else {
          const completed = await completeWithoutPullRequest(
            ctx,
            snapshot.result,
            sessionId,
            nextRuntimeMinutes,
          );
          if (completed) await meterAgentRun("complete_no_pr");
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

    // Compatibility path for a durable session created before propose_pr
    // became terminal: park its already-delivered PR while it waits for a PR
    // event or human message.
    if (snapshot.status === "idle" && !snapshot.result) {
      const openPrs = await db.query.agentPullRequests.findMany({
        where: and(
          eq(schema.agentPullRequests.incidentId, ctx.incident.id),
          eq(schema.agentPullRequests.state, "open"),
        ),
        columns: {
          repoFullName: true,
          branchName: true,
          baseBranch: true,
          title: true,
          url: true,
        },
        orderBy: [asc(schema.agentPullRequests.createdAt), asc(schema.agentPullRequests.id)],
      });
      if (
        shouldParkCompatibilityPullRequests({
          openPullRequestCount: openPrs.length,
          blockingPullRequestDeliveryKind:
            snapshot.blockingPullRequestDelivery?.kind ??
            (snapshot.partialPullRequestDelivery ? "retry_required" : null),
        })
      ) {
        const parkedResult = reconcileDeliveredPullRequests(
          assembleAgentRunResult({
            findings: snapshot.pendingOutcome?.findings ?? null,
            terminal: null,
            actions: snapshot.pendingOutcome?.actions ?? [],
          }),
          openPrs,
        );
        const openPrUrls = openPrs.map((pr) => pr.url);
        const parkOutcome = await moveAgentRunToAwaitingEvents(
          ctx,
          parkedResult,
          openPrUrls,
          async () => {
            try {
              const linearTicket = await scheduleLinearHandoff(
                ctx,
                parkedResult,
                `awaiting_events:${openPrUrls.join(",")}`,
              );
              if (!linearTicket) return null;
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
          !!snapshot.pendingOutcome?.findings,
        );
        const transition = planAwaitingEventsTransition(parkedResult, parkOutcome);
        if (transition.kind === "complete") {
          const completed = await agentRunLifecycle.completeWithoutPullRequest({
            id: ctx.agentRun.id,
            currentState: ctx.agentRun.state,
            result: transition.result,
          });
          if (completed) await meterAgentRun("complete_with_pr");
          return;
        }
        // A lost park means a concurrent pass owns this turn's conclusion —
        // it also records the usage, so a duplicate here would double-meter.
        if (transition.kind === "parked") await meterAgentRun("awaiting_events", true);
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
      const pendingRepoFullNames = snapshot.partialPullRequestDelivery?.pendingRepoFullNames ?? [];
      const partialRetryPrompt =
        pendingRepoFullNames.length > 0
          ? partialPullRequestRetryNudgePrompt(pendingRepoFullNames)
          : null;
      const nudgeEventId = partialRetryPrompt
        ? `partial_pr_retry_nudge:${sessionId}:${pendingRepoFullNames.join(",")}`
        : `terminal_nudge:${sessionId}`;
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
        const nudgePrompt =
          partialRetryPrompt ??
          terminalOutcomeNudgePrompt(
            terminalOutcomeNudgeCapabilities(snapshot, {
              completeInvestigationAvailable: completeInvestigationAvailable({
                prPolicy: ctx.prPolicy,
                githubConnected: ctx.githubInstalls.length > 0,
              }),
              prCreationAvailable: ctx.githubInstalls.length > 0 && ctx.prPolicy !== "never",
            }),
          );
        const redeliveryMarker = partialRetryPrompt
          ? `${PARTIAL_PULL_REQUEST_RETRY_NUDGE_MARKER} ${JSON.stringify(pendingRepoFullNames)}`
          : TERMINAL_OUTCOME_NUDGE_MARKER;
        const nudgeAlreadyDelivered = snapshot.events.some(
          (event) =>
            event.type === "user.message" &&
            !!event.summary &&
            event.summary.includes(redeliveryMarker),
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
