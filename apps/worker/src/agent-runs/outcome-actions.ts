// Server-side execution of the agent's non-terminal outcome action tools.
//
// The runner backend's dispatch loop (the same one that serves memory and
// integration tools) hands each pending action call to the executor built
// here; the executor validates it, applies the effect — open/update a PR,
// classify one linked issue — and returns a model-readable payload that the
// dispatch loop acks back into the live session. Failures are acks, not run
// failures: the agent reads the error (e.g. a patch that didn't apply) and
// corrects itself within the same session.
//
// `resolve_incident` is guarded here but APPLIED by the completion path: the
// guard (every linked issue classified) needs a DB read at ack time so the
// rejection reaches the model as a tool error; once the ack is out, the
// collect pass captures the call as the run's terminal outcome and sync's
// completion path performs the actual resolve.

import { classifyIncidentIssue, listUnclassifiedIncidentIssues, db } from "@superlog/db";
import {
  escalationTriggerFromObservation,
  isActionOutcomeToolName,
  type ProposePrPayload,
  validateOutcomeToolInput,
} from "../agent-outcome-tools.js";
import type { AgentRunContext } from "../agent-run-context.js";
import type { OutcomeActionCall, OutcomeActionExecution } from "../agent-runner-backend.js";
import { hasRevylCreateTestIntegration, looksLikeMobileChange } from "./mobile-regression.js";
import { loadEnabledIntegrationsForOrg } from "../integrations.js";
import { logger } from "../logger.js";
import { deliverProposedPullRequest } from "./pr-delivery.js";

// Orgs with the Revyl integration must attach a mobile regression-test
// decision to mobile-looking PRs. Enforced at dispatch time so the agent is
// told immediately, instead of the old post-hoc completion-repair steer.
async function missingMobileTestDecision(
  ctx: AgentRunContext,
  payload: ProposePrPayload,
): Promise<boolean> {
  if (payload.mobileTestStatus) return false;
  if (!looksLikeMobileChange({ service: ctx.incident.service, changedFiles: payload.changedFiles })) {
    return false;
  }
  try {
    const integrations = await loadEnabledIntegrationsForOrg(ctx.project.orgId);
    return hasRevylCreateTestIntegration(integrations);
  } catch (err) {
    logger.error(
      { err, orgId: ctx.project.orgId },
      "failed to load integrations for mobile regression gate; skipping the gate",
    );
    return false;
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
    if (!isActionOutcomeToolName(call.name) && call.name !== "resolve_incident") {
      return { handled: false };
    }

    const validated = validateOutcomeToolInput(call.name, call.input, {
      hasFindings: call.hasFindings,
    });
    if (!validated.ok) {
      return { handled: true, ok: false, payload: { ok: false, errors: validated.errors } };
    }

    switch (validated.tool) {
      case "propose_pr": {
        const payload = validated.payload as ProposePrPayload;
        if (await missingMobileTestDecision(ctx, payload)) {
          return {
            handled: true,
            ok: false,
            payload: {
              ok: false,
              errors: [
                'This looks like a mobile change and the Revyl integration is enabled, so propose_pr requires a mobile regression-test decision. If the fix can be covered by a reliable mobile user flow, author the Revyl YAML, call `revyl_validate_yaml`, then `revyl_create_test_from_yaml`, and call `propose_pr` again with `mobileTestStatus="created"` plus the returned test id as `mobileTestId`. Otherwise call it again with `mobileTestStatus="skipped"` (or "not_applicable") and a concrete `mobileTestReason`.',
              ],
            },
          };
        }
        const delivery = await deliverProposedPullRequest(ctx, payload, sessionId);
        if (!delivery.ok) {
          return { handled: true, ok: false, payload: { ok: false, errors: [delivery.error] } };
        }
        return {
          handled: true,
          ok: true,
          payload: {
            ok: true,
            prUrl: delivery.url,
            prNumber: delivery.prNumber,
            branchName: delivery.branchName,
            updatedExisting: delivery.updatedExisting,
          },
        };
      }

      case "silence_as_noise":
      case "place_under_observation":
      case "resolve_issue": {
        const payload = validated.payload as {
          issueId: string;
          reason: string;
          evidence: string;
          escalateOn?: "events_per_minute" | "additional_events";
          threshold?: number;
        };
        const action =
          validated.tool === "silence_as_noise"
            ? ({ kind: "silence" } as const)
            : validated.tool === "place_under_observation"
              ? ({
                  kind: "observe",
                  trigger: escalationTriggerFromObservation({
                    escalateOn: payload.escalateOn as "events_per_minute" | "additional_events",
                    threshold: payload.threshold as number,
                  }),
                } as const)
              : ({ kind: "resolve" } as const);
        const result = await classifyIncidentIssue(db, {
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
        const unclassified = await listUnclassifiedIncidentIssues(db, ctx.incident.id);
        if (unclassified.length > 0) {
          return {
            handled: true,
            ok: false,
            payload: {
              ok: false,
              errors: [
                `Cannot resolve the incident yet: ${unclassified.length} linked issue(s) are still open and must be classified first (silence_as_noise / place_under_observation / resolve_issue): ${unclassified
                  .map((issue) => `${issue.id} ("${issue.title}")`)
                  .join(", ")}.`,
              ],
            },
          };
        }
        // Guard passed — ack final; the collect pass captures this call as
        // the terminal outcome and the completion path applies the resolve.
        return { handled: true, ok: true, payload: { ok: true, final: true } };
      }

      default:
        return { handled: false };
    }
  };
}
