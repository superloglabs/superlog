// Pure phase model for the onboarding Render connect flow, split out of the
// component so the transitions are unit-testable (the `.tsx` can't be imported
// by the node:test runner). Mirrors railwayConnectModel.ts.
//
// Render connect has no OAuth round-trip: the user pastes an API key (Render
// dashboard → Account settings → API Keys), we list the workspaces the key can
// see, they pick one, and the connect call stores the key encrypted. The
// milestone that unlocks "Continue" is that the workspace is connected
// (`installed`); telemetry arrival is surfaced as a bonus but never blocks.

export type RenderPhase = "start" | "pick" | "connected";

/**
 * Resolve the flow phase:
 *  - `installed`     → the connect call finished and the key is stored.
 *  - `ownersLoaded`  → the pasted key validated; the user is picking the
 *                      workspace to share.
 *  - otherwise       → the initial API-key form.
 */
export function renderPhase(input: { installed: boolean; ownersLoaded: boolean }): RenderPhase {
  if (input.installed) return "connected";
  if (input.ownersLoaded) return "pick";
  return "start";
}

/** Continue unlocks once the workspace is connected. */
export function canContinueRender(phase: RenderPhase): boolean {
  return phase === "connected";
}

/**
 * User-facing message for a failed owners/connect call. The fetcher throws
 * `Error("<status>: <body>")`, so match on the API's stable error codes.
 */
export function renderErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (raw.includes("invalid_key")) {
    return "Render rejected that API key. Paste a key from Render's Account settings → API Keys.";
  }
  if (raw.includes("unknown_owner")) {
    return "That workspace isn't visible to this API key anymore. Validate the key again and re-pick.";
  }
  if (raw.includes("render_unavailable")) {
    return "We couldn't reach Render's API. Try again in a moment.";
  }
  return "We couldn't finish connecting Render. Try again.";
}

/** Status text for the small banner in the "connected" state. */
export function renderStatusText(phase: RenderPhase, eventsArrived: boolean): string {
  switch (phase) {
    case "start":
      return "Not connected yet.";
    case "pick":
      return "Key validated — pick the workspace to share.";
    default:
      return eventsArrived
        ? "Connected — telemetry from Render is arriving."
        : "Connected — Render is sending logs and metrics from your services. First events typically appear within a minute.";
  }
}
