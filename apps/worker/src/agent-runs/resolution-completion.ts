import type { AgentRunResult } from "@superlog/db";

export function agentResolveEventDedupeKey(agentRunId: string, toolUseId: string): string {
  return `incident_resolved:agent_run:${agentRunId}:resolve_incident:${toolUseId}`;
}

export function resolutionCompletionResult(
  result: AgentRunResult,
  resolutionCommittedByRun: boolean,
): AgentRunResult {
  if (resolutionCommittedByRun) return result;

  const {
    incidentResolution: _incidentResolution,
    incidentResolutionEventDedupeKey: _incidentResolutionEventDedupeKey,
    issueClassifications: _issueClassifications,
    ...findings
  } = result;
  return findings;
}

export type ResolutionCompletionCopy = {
  logMessage: string;
  threadLead: string;
  status: string;
};

export function resolutionCompletionCopy(
  resolutionCommittedByRun: boolean,
  resolutionReason: string,
): ResolutionCompletionCopy {
  if (resolutionCommittedByRun) {
    return {
      logMessage: "agent run complete (incident resolved by agent)",
      threadLead: `:white_check_mark: Investigation resolved this incident: ${resolutionReason}`,
      status: "Incident resolved by the agent",
    };
  }

  return {
    logMessage: "agent run complete after incident closed by another path",
    threadLead:
      ":white_check_mark: Investigation finished after this incident was closed by another path.",
    status: "Incident closed outside this run",
  };
}

export function shouldUpdateResolutionMainMessage(resolutionCommittedByRun: boolean): boolean {
  return resolutionCommittedByRun;
}
