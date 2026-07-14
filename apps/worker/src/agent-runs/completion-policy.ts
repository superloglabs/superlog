export type TicketCreatingTerminalOutcome = "complete_investigation" | "resolve_incident";

export function shouldCreateLinearTicketForTerminalOutcome(
  outcome: TicketCreatingTerminalOutcome,
  createOnResolve: boolean,
): boolean {
  return outcome === "complete_investigation" || createOnResolve;
}
