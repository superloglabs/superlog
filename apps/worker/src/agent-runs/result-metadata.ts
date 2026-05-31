import { type AgentRunResult, createIncidentLifecycle, db } from "@superlog/db";
import type { AgentRunContext } from "../agent-run-context.js";
import { normalizeNoiseReason, normalizeSeverity } from "../incident-result-policy.js";

const incidentLifecycle = createIncidentLifecycle(db);

export function truncateSlackText(value: string, maxLength = 2600): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

export function isAlertIncident(ctx: AgentRunContext): boolean {
  return ctx.issueRows.some((issue) => issue.kind === "alert");
}

export async function applyIncidentMetadataFromResult(
  ctx: AgentRunContext,
  result: AgentRunResult,
): Promise<boolean> {
  const normalized: AgentRunResult = {
    ...result,
    severity: normalizeSeverity(result.severity),
    noiseClassification: result.noiseClassification
      ? {
          ...result.noiseClassification,
          reason:
            normalizeNoiseReason(result.noiseClassification.reason) ??
            result.noiseClassification.reason,
        }
      : result.noiseClassification,
  };
  const outcome = await incidentLifecycle.applyAgentRunResult({
    incident: ctx.incident,
    agentRunId: ctx.agentRun.id,
    result: normalized,
  });
  return outcome.updated;
}
