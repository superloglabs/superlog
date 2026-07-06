// Pure phase model for the onboarding Vercel connect flow, split out of the
// component so the transitions are unit-testable (the `.tsx` can't be imported
// by the node:test runner). Mirrors cloudflareConnectModel.ts.
//
// Like Cloudflare (and unlike AWS's CloudFormation stack + role verify), Vercel
// connect is a single OAuth round-trip: the user installs our integration, we
// create the drains that stream their deployments' telemetry, and the
// install row appears. So the milestone that unlocks "Continue" is simply that
// the account is connected (`installed`) — telemetry arrival is surfaced as a
// bonus but never blocks.

export type VercelPhase = "start" | "connecting" | "connected";

// Shown on every pre-connect surface (onboarding start panel, settings card)
// so a Hobby-team user learns about the gate before the OAuth round-trip, not
// from the drains_unavailable failure after it. Vercel only offers Drains —
// the mechanism the integration streams telemetry through — on paid teams.
export const VERCEL_PLAN_REQUIREMENT =
  "Requires a Vercel Pro or Enterprise team — Vercel doesn't offer Drains on the Hobby (free) plan.";

/**
 * Resolve the flow phase:
 *  - `installed`  → the OAuth round-trip finished and drains were created.
 *  - `launched`   → the user opened the install screen but we haven't seen the
 *                   install land yet (waiting on the round-trip).
 *  - otherwise    → the initial "connect" call to action.
 */
export function vercelPhase(input: { installed: boolean; launched: boolean }): VercelPhase {
  if (input.installed) return "connected";
  if (input.launched) return "connecting";
  return "start";
}

/** Continue unlocks once the account is connected. */
export function canContinueVercel(phase: VercelPhase): boolean {
  return phase === "connected";
}

// The OAuth callback lands on the /connect/vercel result page, whose
// "Back to Superlog" link carries `?vercel=installed|denied|error|...` back to
// `/`. `installed` is handled by the install poll flipping to "connected";
// failure outcomes reset out of the waiting state rather than spin forever.
export type VercelOutcome = "installed" | "denied" | "error" | "drains_unavailable" | null;

export function parseVercelOutcome(value: string | null | undefined): VercelOutcome {
  if (
    value === "installed" ||
    value === "denied" ||
    value === "error" ||
    value === "drains_unavailable"
  ) {
    return value;
  }
  return null;
}

/** User-facing message for a failure outcome (null when not a failure). */
export function vercelOutcomeMessage(outcome: VercelOutcome): string | null {
  switch (outcome) {
    case "denied":
      return "Vercel authorization was declined. Reconnect to try again.";
    case "error":
      return "We couldn't finish connecting Vercel. Reconnect to try again.";
    case "drains_unavailable":
      return "Vercel Drains aren't available for that team. Drains require a Vercel Pro or Enterprise team; upgrade in Vercel or install on an eligible team.";
    default:
      return null;
  }
}

/** Status text for the small banner in the "connecting" / "connected" states. */
export function vercelStatusText(phase: VercelPhase, eventsArrived: boolean): string {
  switch (phase) {
    case "start":
      return "Not connected yet.";
    case "connecting":
      return "Waiting for you to approve access in the Vercel tab…";
    default:
      return eventsArrived
        ? "Connected — telemetry from Vercel is arriving."
        : "Connected — the Vercel drains are set up. First events will appear as your deployments serve traffic.";
  }
}
