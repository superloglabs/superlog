import type { AgentPrAnalyticsPr } from "./pr-analytics.js";

export function linearTicketAcceptanceUnit(ticket: {
  id: string;
  incidentId: string;
  agentRunId: string;
  url: string | null;
}): AgentPrAnalyticsPr {
  return {
    id: `linear:${ticket.id}`,
    incidentId: ticket.incidentId,
    agentRunId: ticket.agentRunId,
    repoFullName: "linear",
    prNumber: 0,
    url: ticket.url ?? "",
  };
}
