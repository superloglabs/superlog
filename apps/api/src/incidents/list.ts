import type { AgentRun, Incident, IncidentResolutionProposalConfidence } from "@superlog/db";

export type IncidentListStats = {
  windowDays: number;
  buckets: { day: string; count: number }[];
  impactedUsers: number;
  impactedUsersAvailable: boolean;
  impactedUsersCapped: boolean;
};

export type IncidentListPendingResolutionProposal = {
  id: string;
  sourceKind: string;
  confidence: IncidentResolutionProposalConfidence;
  proposedReasonCode: string;
  proposedReasonText: string;
  proposedAt: string;
};

export type IncidentListItemInput = {
  incident: Incident;
  agentRun: AgentRun | null;
  pendingResolutionProposal: IncidentListPendingResolutionProposal | null;
  stats?: IncidentListStats;
};

export type IncidentListItem = {
  incident: Incident;
  agentRun: AgentRun | null;
  pendingResolutionProposal: IncidentListPendingResolutionProposal | null;
  windowDays?: number;
  buckets?: { day: string; count: number }[];
  impactedUsers?: number;
  impactedUsersAvailable?: boolean;
  impactedUsersCapped?: boolean;
};

export function shouldInlineIncidentListStats(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

export function buildIncidentListItem(input: IncidentListItemInput): IncidentListItem {
  const base = {
    incident: input.incident,
    agentRun: input.agentRun,
    pendingResolutionProposal: input.pendingResolutionProposal,
  };

  if (!input.stats) return base;

  return {
    ...base,
    windowDays: input.stats.windowDays,
    buckets: input.stats.buckets,
    impactedUsers: input.stats.impactedUsers,
    impactedUsersAvailable: input.stats.impactedUsersAvailable,
    impactedUsersCapped: input.stats.impactedUsersCapped,
  };
}
