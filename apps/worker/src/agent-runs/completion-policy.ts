import type { AgentRunResult, PrPolicy } from "@superlog/db";

export type TicketCreatingTerminalOutcome =
  | "create_linear_issue"
  | "complete_investigation"
  | "resolve_incident";

export function shouldCreateLinearTicketForTerminalOutcome(
  outcome: TicketCreatingTerminalOutcome,
  createOnResolve: boolean,
): boolean {
  return (
    outcome === "create_linear_issue" || outcome === "complete_investigation" || createOnResolve
  );
}

export function shouldOfferOpenPr(input: {
  completionKind: AgentRunResult["completionKind"];
  prPolicy: PrPolicy;
  githubConnected: boolean;
}): boolean {
  return (
    input.completionKind === "investigation_complete" &&
    input.prPolicy === "never" &&
    input.githubConnected
  );
}
