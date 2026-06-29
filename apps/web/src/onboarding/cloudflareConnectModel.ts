// Pure phase model for the onboarding Cloudflare connect flow, split out of the
// component so the transitions are unit-testable (the `.tsx` can't be imported
// by the node:test runner). Mirrors awsConnectModel.ts.
//
// Unlike AWS (CloudFormation stack + role verify), Cloudflare connect is a
// single OAuth round-trip: the user authorizes, we create Workers Observability
// destinations, and the install row appears. So the milestone that unlocks
// "Continue" is simply that the account is connected (`installed`) — telemetry
// arrival is surfaced as a bonus but never blocks.

export type CloudflarePhase = "start" | "connecting" | "connected";

/**
 * Resolve the flow phase:
 *  - `installed`  → the OAuth round-trip finished and destinations were created.
 *  - `launched`   → the user opened the consent screen but we haven't seen the
 *                   install land yet (waiting on the round-trip).
 *  - otherwise    → the initial "connect" call to action.
 */
export function cloudflarePhase(input: {
  installed: boolean;
  launched: boolean;
}): CloudflarePhase {
  if (input.installed) return "connected";
  if (input.launched) return "connecting";
  return "start";
}

/** Continue unlocks once the account is connected. */
export function canContinueCloudflare(phase: CloudflarePhase): boolean {
  return phase === "connected";
}

// The OAuth callback redirects back with `?cloudflare=installed|denied|error`.
// `installed` is handled by the install poll flipping to "connected"; the other
// two are terminal failures the flow must surface (and reset out of the waiting
// state) rather than spin forever.
export type CloudflareOutcome = "installed" | "denied" | "error" | null;

export function parseCloudflareOutcome(value: string | null | undefined): CloudflareOutcome {
  if (value === "installed" || value === "denied" || value === "error") return value;
  return null;
}

/** User-facing message for a failure outcome (null when not a failure). */
export function cloudflareOutcomeMessage(outcome: CloudflareOutcome): string | null {
  switch (outcome) {
    case "denied":
      return "Cloudflare authorization was declined. Reconnect to try again.";
    case "error":
      return "We couldn't finish connecting Cloudflare — no telemetry destinations were created. Reconnect to try again.";
    default:
      return null;
  }
}

/** Status text for the small banner in the "connecting" / "connected" states. */
export function cloudflareStatusText(phase: CloudflarePhase, eventsArrived: boolean): string {
  switch (phase) {
    case "start":
      return "Not connected yet.";
    case "connecting":
      return "Waiting for you to approve access in the Cloudflare tab…";
    default:
      return eventsArrived
        ? "Connected — telemetry from Cloudflare is arriving."
        : "Connected — destinations are set up. First events will appear as your Workers run.";
  }
}
