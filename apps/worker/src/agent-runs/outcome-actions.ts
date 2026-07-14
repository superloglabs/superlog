// Server-side execution of terminal outcomes that need delivery or database
// validation before their success ack can end the turn.
//
// The runner backend's dispatch loop (the same one that serves memory and
// integration tools) hands each pending call to the executor built here; the
// executor opens/updates a batch of PRs or applies the complete atomic
// resolution, then returns a model-readable payload that the
// dispatch loop acks back into the live session. Failures are acks, not run
// failures: the agent reads the error (e.g. a patch that didn't apply) and
// corrects itself within the same session.

import {
  type ResolveIncidentInput,
  type ResolveIncidentResult,
  classifyIncidentIssue,
  createIncidentLifecycle,
  db,
  type schema,
  synthesizeLegacyIncidentIssueOutcomes,
  validateIncidentIssueOutcomes,
} from "@superlog/db";
import {
  type ProposePrPayload,
  type PullRequestProposal,
  type ResolveIncidentPayload,
  escalationTriggerFromObservation,
  isDispatchedOutcomeToolName,
  isLegacyIssueActionToolName,
  isRetiredOutcomeToolName,
  validateLegacyOutcomeToolInput,
  validateOutcomeToolInput,
} from "../agent-outcome-tools.js";
import type { AgentRunContext } from "../agent-run-context.js";
import type { OutcomeActionCall, OutcomeActionExecution } from "../agent-runner-backend.js";
import { loadEnabledIntegrationsForOrg } from "../integrations.js";
import { logger } from "../logger.js";
import { AGENT_RESOLVED_REASON_CODE } from "./completion.js";
import { createDatabaseOutcomeActionReceiptLock } from "./database-outcome-action-receipts.js";
import type { PullRequestDeliveryIdentity } from "./deliverable-records.js";
import { hasRevylCreateTestIntegration, looksLikeMobileChange } from "./mobile-regression.js";
import {
  type OutcomeActionReceiptLock,
  outcomeActionInputHash,
  runOutcomeActionWithReceipt,
} from "./outcome-action-receipts.js";
import {
  type ProposedPullRequestCompensationFailure,
  type ProposedPullRequestDeliveryResult,
  type PullRequestManualReconciliation,
  deliverProposedPullRequest,
  preflightProposedPullRequest,
} from "./pr-delivery.js";
import { agentResolveEventDedupeKey } from "./resolution-completion.js";

const incidentLifecycle = createIncidentLifecycle(db);
const databaseOutcomeActionReceiptLock = createDatabaseOutcomeActionReceiptLock(db);

export type OutcomeActionDependencies = {
  classifyIncidentIssue: typeof classifyIncidentIssue;
  synthesizeLegacyIncidentIssueOutcomes: typeof synthesizeLegacyIncidentIssueOutcomes;
  resolveIncident(input: ResolveIncidentInput): Promise<ResolveIncidentResult>;
  preflightProposedPullRequest: typeof preflightProposedPullRequest;
  deliverProposedPullRequest: typeof deliverProposedPullRequest;
};

const databaseOutcomeActionDependencies: OutcomeActionDependencies = {
  classifyIncidentIssue,
  synthesizeLegacyIncidentIssueOutcomes,
  resolveIncident: (input) => incidentLifecycle.resolve(input),
  preflightProposedPullRequest,
  deliverProposedPullRequest,
};

export function pullRequestDeliveryIdentityForOutcomeAction(
  agentRunId: string,
  toolUseId: string,
  proposal: PullRequestProposal,
): PullRequestDeliveryIdentity {
  return {
    deliveryId: outcomeActionInputHash({
      scope: "pull_request_delivery",
      agentRunId,
      toolUseId,
      repoFullName: proposal.repoFullName,
    }),
    inputHash: outcomeActionInputHash(proposal),
    requestedBranchName: proposal.branchName,
  };
}

export type ProposedPullRequestBatchEntry = {
  repoFullName: string;
  branchName: string;
  status: "delivered" | "validation_failed" | "delivery_failed" | "not_delivered";
  error?: string;
  prUrl?: string;
  prNumber?: number;
  updatedExisting?: boolean;
  deliveryStatus?: ProposedPullRequestCompensationFailure["deliveryStatus"];
  retryable?: boolean;
  incidentStatus?: schema.IncidentStatus | null;
  manualReconciliation?: PullRequestManualReconciliation;
};

export type ProposedPullRequestBatchResult = {
  ok: boolean;
  pullRequests: ProposedPullRequestBatchEntry[];
};

export function proposedPullRequestBatchErrors(batch: ProposedPullRequestBatchResult): string[] {
  if (
    batch.pullRequests.some((entry) => entry.deliveryStatus === "manual_reconciliation_required")
  ) {
    return [
      "PR delivery requires manual reconciliation. Do not retry or perform another mutation; record findings, then call ask_human with the reconciliation request.",
    ];
  }
  if (batch.pullRequests.some((entry) => entry.deliveryStatus === "incident_not_open")) {
    return [
      "The Incident is no longer open. Do not retry propose_pr; record findings, then call resolve_incident to acknowledge the resolved state or ask_human if reconciliation needs a person.",
    ];
  }
  const delivered = batch.pullRequests.some((entry) => entry.status === "delivered");
  return delivered
    ? ["One or more PRs failed. Retry only entries whose status is not delivered."]
    : [
        "No PRs were delivered. Retry every pullRequests entry after correcting the validation or delivery failures.",
      ];
}

export async function executeProposedPullRequestBatch<Prepared>(
  proposals: PullRequestProposal[],
  deps: {
    preflight(
      proposal: PullRequestProposal,
    ): Promise<{ ok: true; prepared: Prepared } | { ok: false; error: string }>;
    deliver(
      proposal: PullRequestProposal,
      prepared: Prepared,
    ): Promise<ProposedPullRequestDeliveryResult>;
  },
): Promise<ProposedPullRequestBatchResult> {
  const preflights = await Promise.all(proposals.map((proposal) => deps.preflight(proposal)));
  if (preflights.some((preflight) => !preflight.ok)) {
    return {
      ok: false,
      pullRequests: proposals.map((proposal, index) => {
        const preflight = preflights[index];
        return preflight && !preflight.ok
          ? {
              repoFullName: proposal.repoFullName,
              branchName: proposal.branchName,
              status: "validation_failed" as const,
              error: preflight.error,
            }
          : {
              repoFullName: proposal.repoFullName,
              branchName: proposal.branchName,
              status: "not_delivered" as const,
              error: "The batch was not delivered because another patch failed validation.",
            };
      }),
    };
  }

  const deliveries: ProposedPullRequestDeliveryResult[] = [];
  let blockedBy: ProposedPullRequestCompensationFailure | null = null;
  for (const [index, proposal] of proposals.entries()) {
    const preflight = preflights[index];
    if (!preflight?.ok) throw new Error("validated preflight unexpectedly missing");
    try {
      const delivery = await deps.deliver(proposal, preflight.prepared);
      deliveries.push(delivery);
      if (
        !delivery.ok &&
        (delivery.deliveryStatus === "incident_not_open" ||
          delivery.deliveryStatus === "manual_reconciliation_required")
      ) {
        blockedBy = delivery;
        break;
      }
    } catch (err) {
      deliveries.push({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return {
    ok: deliveries.every((delivery) => delivery.ok),
    pullRequests: proposals.map((proposal, index) => {
      const delivery = deliveries[index];
      if (!delivery) {
        return {
          repoFullName: proposal.repoFullName,
          branchName: proposal.branchName,
          status: "not_delivered" as const,
          error: blockedBy
            ? `Not delivered because an earlier PR mutation ended with ${blockedBy.deliveryStatus}.`
            : "PR delivery returned no result.",
        };
      }
      if (!delivery.ok) {
        return {
          repoFullName: proposal.repoFullName,
          branchName: proposal.branchName,
          status: "delivery_failed" as const,
          error: delivery.error,
          ...(delivery.deliveryStatus
            ? {
                deliveryStatus: delivery.deliveryStatus,
                retryable: delivery.retryable,
                ...(delivery.deliveryStatus === "incident_not_open"
                  ? { incidentStatus: delivery.incidentStatus }
                  : {}),
                ...(delivery.deliveryStatus === "manual_reconciliation_required"
                  ? { manualReconciliation: delivery.manualReconciliation }
                  : {}),
              }
            : {}),
        };
      }
      return {
        repoFullName: proposal.repoFullName,
        branchName: delivery.branchName,
        status: "delivered" as const,
        prUrl: delivery.url,
        prNumber: delivery.prNumber,
        updatedExisting: delivery.updatedExisting,
      };
    }),
  };
}

// Orgs with the Revyl integration must attach a mobile regression-test
// decision to mobile-looking PRs. Enforced at dispatch time so the agent is
// told immediately, instead of the old post-hoc completion-repair steer.
export async function missingMobileTestDecision(
  ctx: AgentRunContext,
  payload: PullRequestProposal,
  loadIntegrations: typeof loadEnabledIntegrationsForOrg = loadEnabledIntegrationsForOrg,
): Promise<boolean> {
  if (payload.mobileTestStatus) return false;
  if (
    !looksLikeMobileChange({ service: ctx.incident.service, changedFiles: payload.changedFiles })
  ) {
    return false;
  }
  try {
    const integrations = await loadIntegrations(ctx.project.orgId);
    return hasRevylCreateTestIntegration(integrations);
  } catch (err) {
    logger.error(
      { err, orgId: ctx.project.orgId },
      "failed to load integrations for mobile regression gate",
    );
    throw new Error(
      "Could not verify the mobile regression integration. Retry propose_pr once the integration lookup recovers.",
    );
  }
}

// Build the executor the runner backend's dispatch loop calls for each
// pending outcome-action tool use. Returns `handled: false` for tool names
// that are not outcome actions (memory/integration/terminal tools).
export function createOutcomeActionExecutor(
  ctx: AgentRunContext,
  sessionId: string,
  receiptLock: OutcomeActionReceiptLock = databaseOutcomeActionReceiptLock,
  dependencyOverrides: Partial<OutcomeActionDependencies> = {},
): (call: OutcomeActionCall) => Promise<OutcomeActionExecution> {
  const dependencies = { ...databaseOutcomeActionDependencies, ...dependencyOverrides };
  return async (call) => {
    if (!isDispatchedOutcomeToolName(call.name) && !isRetiredOutcomeToolName(call.name)) {
      return { handled: false };
    }

    const execution = await runOutcomeActionWithReceipt(
      receiptLock,
      {
        incidentId: ctx.incident.id,
        agentRunId: ctx.agentRun.id,
        toolUseId: call.toolUseId,
        toolName: call.name,
        input: call.input,
      },
      async () => {
        const legacyResolve =
          call.name === "resolve_incident" &&
          !!call.input &&
          typeof call.input === "object" &&
          !Array.isArray(call.input) &&
          !("issueOutcomes" in call.input);
        const validated =
          isLegacyIssueActionToolName(call.name) || legacyResolve
            ? validateLegacyOutcomeToolInput(call.name, call.input, {
                hasFindings: call.hasFindings,
              })
            : validateOutcomeToolInput(call.name, call.input, {
                hasFindings: call.hasFindings,
              });
        if (!validated.ok) {
          return {
            handled: true,
            ok: false,
            payload: { ok: false, errors: validated.errors },
          };
        }

        // A transient DB/GitHub throw stays inside the action contract so the
        // agent can correct the call with a new tool use. Exact replays of this
        // tool use receive the same durable acknowledgement.
        try {
          return await executeValidatedCall(
            ctx,
            sessionId,
            call.toolUseId,
            validated,
            call.findings,
            dependencies,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error(
            { err, op: call.name, agentRunId: ctx.agentRun.id, incidentId: ctx.incident.id },
            "outcome action execution threw",
          );
          return { handled: true, ok: false, payload: { ok: false, errors: [message] } };
        }
      },
    );
    if (execution.handled && execution.deferAck) {
      logger.warn(
        { op: call.name, agentRunId: ctx.agentRun.id, toolUseId: call.toolUseId },
        "outcome action receipt unavailable; leaving tool call pending",
      );
    }
    return execution;
  };
}

async function executeValidatedCall(
  ctx: AgentRunContext,
  sessionId: string,
  toolUseId: string,
  validated:
    | Extract<ReturnType<typeof validateOutcomeToolInput>, { ok: true }>
    | Extract<ReturnType<typeof validateLegacyOutcomeToolInput>, { ok: true }>,
  findings: OutcomeActionCall["findings"],
  dependencies: OutcomeActionDependencies,
): Promise<OutcomeActionExecution> {
  switch (validated.tool) {
    case "propose_pr": {
      const payload = validated.payload as ProposePrPayload;
      for (const proposal of payload.pullRequests) {
        if (await missingMobileTestDecision(ctx, proposal)) {
          return {
            handled: true,
            ok: false,
            payload: {
              ok: false,
              errors: [
                `The patch for ${proposal.repoFullName} looks like a mobile change and the Revyl integration is enabled, so that pullRequests entry requires a mobile regression-test decision. Create the test and use mobileTestStatus="created" with mobileTestId, or use "skipped" / "not_applicable" with a concrete mobileTestReason.`,
              ],
            },
          };
        }
      }

      const batch = await executeProposedPullRequestBatch(payload.pullRequests, {
        preflight: (proposal) =>
          dependencies.preflightProposedPullRequest(
            ctx,
            proposal,
            sessionId,
            pullRequestDeliveryIdentityForOutcomeAction(ctx.agentRun.id, toolUseId, proposal),
          ),
        deliver: (proposal, prepared) =>
          dependencies.deliverProposedPullRequest(
            ctx,
            proposal,
            sessionId,
            findings,
            prepared,
            pullRequestDeliveryIdentityForOutcomeAction(ctx.agentRun.id, toolUseId, proposal),
          ),
      });
      if (!batch.ok) {
        return {
          handled: true,
          ok: false,
          payload: {
            ok: false,
            pullRequests: batch.pullRequests,
            errors: proposedPullRequestBatchErrors(batch),
          },
        };
      }
      return {
        handled: true,
        ok: true,
        payload: {
          ok: true,
          final: true,
          pullRequests: batch.pullRequests,
        },
      };
    }

    case "silence_as_noise":
    case "place_under_observation":
    case "resolve_issue": {
      const payload = validated.payload;
      const action =
        validated.tool === "silence_as_noise"
          ? ({ kind: "silence" } as const)
          : validated.tool === "place_under_observation"
            ? ({
                kind: "observe",
                trigger: escalationTriggerFromObservation(validated.payload),
              } as const)
            : ({ kind: "resolve" } as const);
      const result = await dependencies.classifyIncidentIssue(db, {
        incidentId: ctx.incident.id,
        issueId: payload.issueId,
        agentRunId: ctx.agentRun.id,
        action,
        reason: payload.reason,
        evidence: payload.evidence,
      });
      if (!result.ok) {
        return { handled: true, ok: false, payload: { ok: false, errors: [result.message] } };
      }
      return {
        handled: true,
        ok: true,
        payload: {
          ok: true,
          issueId: payload.issueId,
          status: result.status,
          alreadyClassified: result.alreadyClassified,
        },
      };
    }

    case "resolve_incident": {
      const payload = validated.payload;
      const isLegacy = !("issueOutcomes" in payload);
      let issueOutcomes: schema.AgentRunIssueClassification[];
      let compatibilityIssueOutcomes: ResolveIncidentPayload["issueOutcomes"] | null = null;
      if (isLegacy) {
        const synthesized = await dependencies.synthesizeLegacyIncidentIssueOutcomes(db, {
          incidentId: ctx.incident.id,
          agentRunId: ctx.agentRun.id,
        });
        if (!synthesized.ok) {
          return {
            handled: true,
            ok: false,
            payload: { ok: false, errors: synthesized.errors },
          };
        }
        issueOutcomes = synthesized.outcomes;
        compatibilityIssueOutcomes = issueOutcomes.map(
          (outcome): ResolveIncidentPayload["issueOutcomes"][number] => {
            const base = {
              issueId: outcome.issueId,
              reason: outcome.reason,
              evidence: outcome.evidence,
            };
            if (outcome.action === "observe") {
              if (!outcome.trigger) {
                throw new Error(`Legacy observation for Issue ${outcome.issueId} has no trigger.`);
              }
              return outcome.trigger.kind === "rate"
                ? {
                    ...base,
                    status: "under_observation",
                    escalateOn: "events_per_minute",
                    threshold: outcome.trigger.perMinute,
                  }
                : {
                    ...base,
                    status: "under_observation",
                    escalateOn: "additional_events",
                    threshold: outcome.trigger.count,
                  };
            }
            return {
              ...base,
              status: outcome.action === "silence" ? "silenced" : "resolved",
            };
          },
        );
      } else {
        issueOutcomes = payload.issueOutcomes.map((outcome) => ({
          issueId: outcome.issueId,
          action:
            outcome.status === "silenced"
              ? ("silence" as const)
              : outcome.status === "under_observation"
                ? ("observe" as const)
                : ("resolve" as const),
          reason: outcome.reason,
          evidence: outcome.evidence,
          ...(outcome.status === "under_observation"
            ? {
                trigger:
                  outcome.escalateOn === "events_per_minute"
                    ? { kind: "rate" as const, perMinute: outcome.threshold }
                    : { kind: "count" as const, count: outcome.threshold },
              }
            : {}),
        }));
        const issueValidation = await validateIncidentIssueOutcomes(
          db,
          ctx.incident.id,
          issueOutcomes,
        );
        if (!issueValidation.ok) {
          return {
            handled: true,
            ok: false,
            payload: {
              ok: false,
              errors: issueValidation.errors,
            },
          };
        }
      }
      const eventDedupeKey = agentResolveEventDedupeKey(ctx.agentRun.id, toolUseId);
      const resolution = await dependencies.resolveIncident({
        incidentId: ctx.incident.id,
        kind: "agent_classification",
        reasonCode: AGENT_RESOLVED_REASON_CODE,
        reasonText: payload.reason,
        agentRunId: ctx.agentRun.id,
        eventSummary: "Incident resolved by the investigating agent.",
        eventDetail: { reason: payload.reason, evidence: payload.evidence },
        eventDedupeKey,
        issueOutcomes,
      });
      // Success is final even when another concurrent path already closed the
      // Incident. Completion uses the run-scoped resolution event to retain
      // classifications only when this call's atomic mutation committed.
      return {
        handled: true,
        ok: true,
        payload: {
          ok: true,
          final: true,
          resolved: resolution.resolved,
          incidentResolutionEventDedupeKey: eventDedupeKey,
          ...(compatibilityIssueOutcomes ? { issueOutcomes: compatibilityIssueOutcomes } : {}),
        },
      };
    }

    default:
      return { handled: false };
  }
}
