import type { AgentRunResult } from "@superlog/db";

export function mergedPullRequestResolutionCopy(opts: {
  prNumber: number;
  repoFullName: string;
}): {
  threadLead: string;
  status: string;
  mainTextSuffix: string;
} {
  return {
    threadLead: `:white_check_mark: All agent pull requests are merged; incident resolved by PR #${opts.prNumber} (${opts.repoFullName}).`,
    status: "Incident resolved - all agent pull requests merged",
    mainTextSuffix: "Incident resolved",
  };
}

export function settledPullRequestResolutionCopy(opts: {
  prNumber: number;
  repoFullName: string;
  settledState: "merged" | "closed";
}): {
  threadLead: string;
  status: string;
  mainTextSuffix: string;
} {
  return {
    threadLead:
      opts.settledState === "merged"
        ? `:white_check_mark: Fix PR #${opts.prNumber} (${opts.repoFullName}) is merged and the remaining agent pull requests are closed; incident resolved.`
        : `:white_check_mark: PR #${opts.prNumber} (${opts.repoFullName}) was closed without merging and no agent pull request remains open; incident resolved.`,
    status: "Incident resolved - all agent pull requests settled",
    mainTextSuffix: "Incident resolved",
  };
}

export function agentResolveEventDedupeKey(agentRunId: string, toolUseId: string): string {
  return `incident_resolved:agent_run:${agentRunId}:resolve_incident:${toolUseId}`;
}

export function legacyResolutionEventDedupeKey(
  agentRunId: string,
  outcome: "already_resolved" | "noise",
): string {
  return `incident_resolved:agent_run:${agentRunId}:${outcome}`;
}

type LegacyTerminalResolutionDisposition =
  | "resolved"
  | "incident_not_open"
  | "agent_run_not_current"
  | "resolution_event_already_consumed"
  | "pull_requests_open"
  | "pull_request_delivery_pending";

export function planLegacyTerminalResolutionCompletion(
  result: AgentRunResult,
  disposition: LegacyTerminalResolutionDisposition,
): {
  result: AgentRunResult;
  resolutionCommitted: boolean;
  blocked: boolean;
  shouldTerminateSession: boolean;
} {
  if (disposition === "resolved") {
    return {
      result,
      resolutionCommitted: true,
      blocked: false,
      shouldTerminateSession: true,
    };
  }

  // A stored pre-cutover terminal snapshot can no longer receive a corrective
  // tool acknowledgement. Preserve its durable findings (and any issue actions
  // that really committed), but never persist the stale Incident-level verdict
  // as though this run won the resolution transaction.
  const {
    incidentResolution: _incidentResolution,
    incidentResolutionEventDedupeKey: _incidentResolutionEventDedupeKey,
    noiseClassification: _noiseClassification,
    resolutionClassification: _resolutionClassification,
    ...nonClaimingResult
  } = result;
  const blocked =
    disposition === "pull_requests_open" || disposition === "pull_request_delivery_pending";
  return {
    result: nonClaimingResult,
    resolutionCommitted: false,
    blocked,
    shouldTerminateSession:
      disposition === "incident_not_open" ||
      disposition === "agent_run_not_current" ||
      disposition === "resolution_event_already_consumed",
  };
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

export function supersededSnapshotCompletionResult(result: AgentRunResult): AgentRunResult {
  const completed = { ...result, state: "complete" as const };
  return result.incidentResolution ? resolutionCompletionResult(completed, false) : completed;
}

export function shouldRetireProviderSession(incidentStatus: string): boolean {
  return incidentStatus !== "open";
}

export function completionIntendsIncidentClosure(opts: {
  hasIncidentOutcome: boolean;
  noiseReason: string | null;
  resolutionReason: string | null;
}): boolean {
  return opts.hasIncidentOutcome || Boolean(opts.noiseReason) || Boolean(opts.resolutionReason);
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

export function incidentAlreadyClosedCompletionCopy(): ResolutionCompletionCopy & {
  updateMainMessage: false;
} {
  return {
    ...resolutionCompletionCopy(false, ""),
    updateMainMessage: false,
  };
}

export function closedElsewhereCopyAfterNoiseRace(opts: {
  noiseReason: string | null;
  noiseApplied: boolean;
  incidentStatus: string;
}): ReturnType<typeof incidentAlreadyClosedCompletionCopy> | null {
  if (!opts.noiseReason || opts.noiseApplied || !shouldRetireProviderSession(opts.incidentStatus)) {
    return null;
  }
  return incidentAlreadyClosedCompletionCopy();
}
