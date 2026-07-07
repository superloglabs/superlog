import { type AgentRunResult, db, schema } from "@superlog/db";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { AgentRunContext } from "../agent-run-context.js";
import { createAgentRunLifecycle } from "../agent-run.js";
import { type AgentRunOutcome, recordAgentRunCompletion } from "../ai-usage.js";
import { investigationGate } from "../billing/investigation-gate.js";
import { usageNotifier } from "../billing/usage-notifier-infra.js";
import { getAgentRunnerBackend } from "../infra/agent-runner/backend.js";
import { postIncidentThreadMessage } from "../infra/slack/incident-messages.js";
import { type ResolvedIntegration, loadEnabledIntegrationsForOrg } from "../integrations.js";
import { logger } from "../logger.js";
import { completeWithoutPullRequest } from "./completion.js";
import { tryMergeAfterAgentRun } from "./merge.js";
import { completeWithPullRequest, resolvePullRequestBaseBranch } from "./pr-delivery.js";
import { applyIncidentMetadataFromResult } from "./result-metadata.js";
import {
  exceededWallClockBudget,
  failAgentRun,
  isTransientError,
  moveAgentRunToAwaitingHuman,
} from "./status.js";

const agentRunLifecycle = createAgentRunLifecycle(db);

export type PendingContextEvent = {
  id: string;
  summary: string | null;
};

export async function steerIdleRunnerWithPendingContext(opts: {
  snapshotStatus: string;
  pendingContextEvents: PendingContextEvent[];
  runner: { steer(sessionId: string, message: string): Promise<void> };
  sessionId: string;
  incidentId: string;
  markEventsProcessed(ids: string[]): Promise<void>;
  notifySteered(incidentId: string): Promise<void>;
}): Promise<boolean> {
  if (opts.snapshotStatus !== "idle" || opts.pendingContextEvents.length === 0) {
    return false;
  }
  const delta = opts.pendingContextEvents
    .map((event) => event.summary)
    .filter((value): value is string => !!value)
    .join("\n");
  await opts.runner.steer(opts.sessionId, delta || "New issues joined the incident.");
  await opts.markEventsProcessed(opts.pendingContextEvents.map((event) => event.id));
  await opts.notifySteered(opts.incidentId);
  return true;
}

const MOBILE_FILE_PREFIXES = ["app/", "ios/", "android/", "components/", "screens/"];
type MobileRegressionToolLookupState = "enabled" | "disabled" | "failed";
type MobileRegressionGateState = "allow" | "repair" | "defer_lookup";

export function hasRevylCreateTestIntegration(integrations: ResolvedIntegration[]): boolean {
  return integrations.some(
    (integration) =>
      integration.definition.slug === "revyl" &&
      integration.definition.operations.some((op) => op.name === "revyl_create_test_from_yaml"),
  );
}

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

  const serviceLooksMobile = /mobile/i.test(opts.service ?? "");
  const changedFiles = pr.changedFiles ?? [];
  const changedMobileFiles = changedFiles.some((file) =>
    MOBILE_FILE_PREFIXES.some((prefix) => file === prefix.slice(0, -1) || file.startsWith(prefix)),
  );
  if (!serviceLooksMobile && !changedMobileFiles) return "allow";
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

// Steered into a session that went idle without calling any terminal outcome
// tool (e.g. the model wrote a chat message instead of a tool call). Fired at
// most once per session; the runtime/wall-clock budgets stay the hard floor.
export function terminalOutcomeNudgePrompt(): string {
  return [
    "You ended your turn without calling a terminal outcome tool, so your investigation has no recorded result.",
    "Call `report_findings` now if you have findings to record, then end your turn by calling exactly ONE terminal outcome tool: `propose_pr`, `silence_as_noise`, `place_under_observation`, `mark_already_resolved`, `complete_investigation`, `ask_human`, or `report_failure`.",
  ].join("\n");
}

export async function syncRunningAgentRun(ctx: AgentRunContext): Promise<void> {
  const sessionId = ctx.agentRun.providerSessionId;
  if (!sessionId) {
    await failAgentRun(ctx, "missing_session", "Investigation has no managed session ID.");
    return;
  }

  try {
    const runner = await getAgentRunnerBackend(ctx.agentRun.runtime);
    const dispatched = await runner
      .dispatchIntegrationToolCalls({
        sessionId,
        orgId: ctx.project.orgId,
        incidentId: ctx.incident.id,
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
    const steeredHuman = await steerIdleRunnerWithPendingContext({
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
    if (steeredHuman) {
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
            await runner.steer(sessionId, mobileRegressionRepairPrompt());
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
    const steered = await steerIdleRunnerWithPendingContext({
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
    if (steered) {
      return;
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
      if (claimed.length > 0) {
        try {
          await runner.steer(sessionId, terminalOutcomeNudgePrompt());
        } catch (err) {
          // Release the claim so a later tick can retry the nudge — a
          // transient steer failure must not permanently spend the one-shot.
          await db
            .delete(schema.incidentEvents)
            .where(eq(schema.incidentEvents.id, claimed[0].id))
            .catch(() => undefined);
          throw err;
        }
        logger.info(
          {
            agent_run_id: ctx.agentRun.id,
            incident_id: ctx.incident.id,
            provider_session_id: sessionId,
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
