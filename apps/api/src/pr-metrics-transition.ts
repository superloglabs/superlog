export type PrTerminalOutcome = "merged" | "closed";

/**
 * Decide which terminal PR counter (if any) a GitHub `pull_request` webhook
 * delivery should increment, given the PR's state *before* this delivery is
 * applied. Returns null unless the delivery represents a brand-new terminal
 * transition, so webhook re-deliveries and reopen→close→reopen cycles don't
 * double-count. "closed" here means closed-without-merge (a merged PR is
 * counted as "merged" only).
 *
 * Kept free of any db import so it can be unit-tested without a connection.
 */
export function prTerminalTransition(args: {
  action: string;
  merged: boolean;
  prevState: string;
}): PrTerminalOutcome | null {
  if (args.action !== "closed") return null;
  if (args.merged) return args.prevState === "merged" ? null : "merged";
  return args.prevState === "closed" ? null : "closed";
}
