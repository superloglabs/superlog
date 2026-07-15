import type { schema } from "@superlog/db";

// The boundaries at which the platform files (or updates) a Linear ticket for
// an investigation. Creation is deterministic and platform-side — the policy
// decides which boundaries produce a ticket at all.
export type LinearTicketBoundary =
  // A fix PR was opened for the incident, or a follow-up landed on one.
  | "pr_delivered"
  // The run completed with findings while leaving the incident open.
  | "investigation_handoff"
  // The completion closes the incident (resolve_incident, noise,
  // already-resolved, or every PR merged).
  | "incident_resolved";

export function shouldDeliverLinearTicket(args: {
  policy: schema.LinearTicketPolicy;
  boundary: LinearTicketBoundary;
  createOnResolve: boolean;
  // A ticket already filed by this run may still be updated/linked at a
  // resolving boundary even when resolve-time creation is off.
  runHasTicket?: boolean;
}): boolean {
  if (args.policy === "never") return false;
  if (args.boundary !== "incident_resolved") return true;
  return args.policy === "always" || args.createOnResolve || args.runHasTicket === true;
}
