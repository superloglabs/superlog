// Pure phase model for the onboarding Google Cloud connect flow, split out of
// the component so the transitions are unit-testable (the `.tsx` can't be
// imported by the node:test runner). Mirrors railwayConnectModel.ts.
//
// GCP connect is an OAuth round-trip followed by a project-selection step that
// happens on the standalone /connect/gcp callback page (opened in a new tab).
// Once the user picks a GCP project there, our backend provisions a Cloud
// Logging route and begins bounded metric collection, moving the connection row
// through `pending`/`provisioning` to `connected`. The onboarding tab polls the
// connection endpoint; the milestone that unlocks "Continue" is `connected`.
// Telemetry arrival is surfaced as a bonus but never blocks.

export type GcpStatus = "pending" | "provisioning" | "connected" | "failed";

export type GcpPhase = "start" | "connecting" | "connected" | "failed";

/**
 * Resolve the flow phase from the polled connection status and whether the user
 * has opened the consent screen this session:
 *  - `connected`    → the project is selected and provisioning finished.
 *  - `failed`       → provisioning errored; offer a reconnect.
 *  - `launched` or a `pending`/`provisioning` row → we're mid round-trip.
 *  - otherwise      → the initial "connect" call to action.
 */
export function gcpPhase(input: { status: GcpStatus | null; launched: boolean }): GcpPhase {
  if (input.status === "connected") return "connected";
  if (input.status === "failed") return "failed";
  if (input.launched || input.status === "pending" || input.status === "provisioning") {
    return "connecting";
  }
  return "start";
}

/** Continue unlocks once the connection is live. */
export function canContinueGcp(phase: GcpPhase): boolean {
  return phase === "connected";
}

/** Status text for the small banner in the connecting / connected states. */
export function gcpStatusText(phase: GcpPhase, eventsArrived: boolean): string {
  switch (phase) {
    case "start":
      return "Not connected yet.";
    case "connecting":
      return "Waiting for you to authorize Google Cloud and pick a project in the other tab…";
    case "failed":
      return "The connection didn't finish. Reconnect to try again.";
    default:
      return eventsArrived
        ? "Connected — telemetry from Google Cloud is arriving."
        : "Connected — we're routing Cloud Logging and reading bounded Cloud Monitoring metrics. First events typically appear within a minute.";
  }
}
