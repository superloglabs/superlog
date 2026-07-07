// Pure phase model for the onboarding Railway connect flow, split out of the
// component so the transitions are unit-testable (the `.tsx` can't be imported
// by the node:test runner). Mirrors vercelConnectModel.ts.
//
// Railway connect is a single OAuth round-trip like Vercel/Cloudflare, but
// nothing is provisioned on Railway's side — Railway has no drains, so once
// the grant lands our worker starts pulling logs and infra metrics from the
// projects the user selected on Railway's consent screen. The milestone that
// unlocks "Continue" is that the account is connected (`installed`); telemetry
// arrival is surfaced as a bonus but never blocks.

export type RailwayPhase = "start" | "connecting" | "connected";

/**
 * Resolve the flow phase:
 *  - `installed`  → the OAuth round-trip finished and the grant is stored.
 *  - `launched`   → the user opened the consent screen but we haven't seen the
 *                   install land yet (waiting on the round-trip).
 *  - otherwise    → the initial "connect" call to action.
 */
export function railwayPhase(input: { installed: boolean; launched: boolean }): RailwayPhase {
  if (input.installed) return "connected";
  if (input.launched) return "connecting";
  return "start";
}

/** Continue unlocks once the account is connected. */
export function canContinueRailway(phase: RailwayPhase): boolean {
  return phase === "connected";
}

// The OAuth callback lands on the /connect/railway result page, whose
// "Back to Superlog" link carries `?railway=installed|denied|error|no_projects`
// back to `/`. `installed` is handled by the install poll flipping to
// "connected"; failure outcomes reset out of the waiting state.
export type RailwayOutcome = "installed" | "denied" | "error" | "no_projects" | null;

export function parseRailwayOutcome(value: string | null | undefined): RailwayOutcome {
  if (value === "installed" || value === "denied" || value === "error" || value === "no_projects") {
    return value;
  }
  return null;
}

/** User-facing message for a failure outcome (null when not a failure). */
export function railwayOutcomeMessage(outcome: RailwayOutcome): string | null {
  switch (outcome) {
    case "denied":
      return "Railway authorization was declined. Reconnect to try again.";
    case "error":
      return "We couldn't finish connecting Railway. Reconnect to try again.";
    case "no_projects":
      return "The Railway grant didn't include any projects. Reconnect and select at least one project on Railway's consent screen.";
    default:
      return null;
  }
}

/** Status text for the small banner in the "connecting" / "connected" states. */
export function railwayStatusText(phase: RailwayPhase, eventsArrived: boolean): string {
  switch (phase) {
    case "start":
      return "Not connected yet.";
    case "connecting":
      return "Waiting for you to approve access in the Railway tab…";
    default:
      return eventsArrived
        ? "Connected — telemetry from Railway is arriving."
        : "Connected — we're pulling logs and metrics from your Railway projects. First events typically appear within a minute.";
  }
}
