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

import { createIncidentLifecycle, db, validateIncidentIssueOutcomes } from "@superlog/db";
import {
  type ProposePrPayload,
  type PullRequestProposal,
  type ResolveIncidentPayload,
  isDispatchedOutcomeToolName,
  isRetiredOutcomeToolName,
  validateOutcomeToolInput,
} from "../agent-outcome-tools.js";
import type { AgentRunContext } from "../agent-run-context.js";
import type { OutcomeActionCall, OutcomeActionExecution } from "../agent-runner-backend.js";
import { loadEnabledIntegrationsForOrg } from "../integrations.js";
import { logger } from "../logger.js";
import { AGENT_RESOLVED_REASON_CODE } from "./completion.js";
import { hasRevylCreateTestIntegration, looksLikeMobileChange } from "./mobile-regression.js";
import {
  type ProposedPullRequestDeliveryResult,
  deliverProposedPullRequest,
  preflightProposedPullRequest,
} from "./pr-delivery.js";
import { agentResolveEventDedupeKey } from "./resolution-completion.js";

const incidentLifecycle = createIncidentLifecycle(db);

export type ProposedPullRequestBatchEntry = {
  repoFullName: string;
  branchName: string;
  status: "delivered" | "validation_failed" | "delivery_failed" | "not_delivered";
  error?: string;
  prUrl?: string;
  prNumber?: number;
  updatedExisting?: boolean;
};

export type ProposedPullRequestBatchResult = {
  ok: boolean;
  pullRequests: ProposedPullRequestBatchEntry[];
};

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
  for (const [index, proposal] of proposals.entries()) {
    const preflight = preflights[index];
    if (!preflight?.ok) throw new Error("validated preflight unexpectedly missing");
    deliveries.push(await deps.deliver(proposal, preflight.prepared));
  }
  return {
    ok: deliveries.every((delivery) => delivery.ok),
    pullRequests: proposals.map((proposal, index) => {
      const delivery = deliveries[index];
      if (!delivery || !delivery.ok) {
        return {
          repoFullName: proposal.repoFullName,
          branchName: proposal.branchName,
          status: "delivery_failed" as const,
          error: delivery?.error ?? "PR delivery returned no result.",
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
): (call: OutcomeActionCall) => Promise<OutcomeActionExecution> {
  return async (call) => {
    if (!isDispatchedOutcomeToolName(call.name) && !isRetiredOutcomeToolName(call.name)) {
      return { handled: false };
    }

    const validated = validateOutcomeToolInput(call.name, call.input, {
      hasFindings: call.hasFindings,
    });
    if (!validated.ok) {
      return { handled: true, ok: false, payload: { ok: false, errors: validated.errors } };
    }

    // A transient DB/GitHub throw must stay inside the action contract — the
    // agent gets a tool error it can retry, instead of the call being left
    // unacked (the backend's dispatch loop also guards this, but the contract
    // shouldn't depend on it).
    try {
      return await executeValidatedCall(ctx, sessionId, validated, call.findings);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        { err, op: call.name, agentRunId: ctx.agentRun.id, incidentId: ctx.incident.id },
        "outcome action execution threw",
      );
      return { handled: true, ok: false, payload: { ok: false, errors: [message] } };
    }
  };
}

async function executeValidatedCall(
  ctx: AgentRunContext,
  sessionId: string,
  validated: Extract<ReturnType<typeof validateOutcomeToolInput>, { ok: true }>,
  findings: OutcomeActionCall["findings"],
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
        preflight: (proposal) => preflightProposedPullRequest(ctx, proposal, sessionId),
        deliver: (proposal, prepared) =>
          deliverProposedPullRequest(ctx, proposal, sessionId, findings, prepared),
      });
      if (!batch.ok) {
        return {
          handled: true,
          ok: false,
          payload: {
            ok: false,
            pullRequests: batch.pullRequests,
            errors: ["One or more PRs failed. Retry only the failed entries."],
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

    case "resolve_incident": {
      const payload = validated.payload as ResolveIncidentPayload;
      const issueOutcomes = payload.issueOutcomes.map((outcome) => ({
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
      const resolution = await incidentLifecycle.resolve({
        incidentId: ctx.incident.id,
        kind: "agent_classification",
        reasonCode: AGENT_RESOLVED_REASON_CODE,
        reasonText: payload.reason,
        agentRunId: ctx.agentRun.id,
        eventSummary: "Incident resolved by the investigating agent.",
        eventDetail: { reason: payload.reason, evidence: payload.evidence },
        eventDedupeKey: agentResolveEventDedupeKey(ctx.agentRun.id),
        issueOutcomes,
      });
      // Success is final even when another concurrent path already closed the
      // Incident. Completion uses the run-scoped resolution event to retain
      // classifications only when this call's atomic mutation committed.
      return {
        handled: true,
        ok: true,
        payload: { ok: true, final: true, resolved: resolution.resolved },
      };
    }

    default:
      return { handled: false };
  }
}
