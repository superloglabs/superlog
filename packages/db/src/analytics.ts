// Server-side product analytics (PostHog).
//
// Best-effort and env-gated, exactly like the Loops integration next door: with
// no POSTHOG_PROJECT_TOKEN configured (local dev, worktrees, a self-host that
// doesn't want analytics) every capture is a silent no-op. Analytics must never
// block or break the request it rides on, so all delivery failures are
// swallowed.
//
// Why server-side at all: the browser `posthog-js` event only fires when the
// user's page actually loaded and ran it, so ad blockers, bots, no-JS clients,
// and users who bounce mid-onboarding never produce one. Lifecycle events we
// need to count reliably (signup, org created, first telemetry) are emitted
// here from the API / proxy against the durable Postgres write, where nothing
// can drop them.

import { PostHog } from "posthog-node";

const DEFAULT_POSTHOG_HOST = "https://eu.i.posthog.com";

// The slice of the PostHog client we use. Narrowed so tests can pass a plain
// recorder and callers can inject one.
export type AnalyticsClient = {
  capture(args: { distinctId: string; event: string; properties?: Record<string, unknown> }): void;
};

export type CaptureServerEventInput = {
  distinctId: string;
  event: string;
  properties?: Record<string, unknown>;
  // Person properties. `set` overwrites (last write wins); `setOnce` only writes
  // the first time (first-touch attribution). Flow through as PostHog's reserved
  // $set / $set_once keys.
  set?: Record<string, unknown>;
  setOnce?: Record<string, unknown>;
};

// `undefined` = not yet resolved; `null` = resolved-but-unconfigured (cached so
// we don't re-read env on every event). A concrete client once configured.
let cachedClient: AnalyticsClient | null | undefined;

// Test seam: when set (including to null), overrides the env-resolved client so
// call-site tests can assert what was captured without touching env or network.
let testOverrideClient: AnalyticsClient | null | undefined;

function resolveEnvClient(): AnalyticsClient | null {
  if (cachedClient !== undefined) return cachedClient;
  const token = process.env.POSTHOG_PROJECT_TOKEN?.trim();
  if (!token) {
    cachedClient = null;
    return null;
  }
  const host = process.env.POSTHOG_HOST?.trim() || DEFAULT_POSTHOG_HOST;
  // flushAt: 1 — these are low-volume lifecycle events, so send each promptly
  // rather than waiting for a batch to fill in a long-running server.
  cachedClient = new PostHog(token, { host, flushAt: 1 });
  return cachedClient;
}

function activeClient(): AnalyticsClient | null {
  if (testOverrideClient !== undefined) return testOverrideClient;
  return resolveEnvClient();
}

/**
 * Emit a server-side analytics event. No-op when analytics isn't configured.
 * Never throws — delivery is best-effort and must not affect the caller.
 */
export function captureServerEvent(input: CaptureServerEventInput): void {
  const client = activeClient();
  if (!client) return;
  try {
    const properties: Record<string, unknown> = { ...input.properties };
    if (input.set) properties.$set = input.set;
    if (input.setOnce) properties.$set_once = input.setOnce;
    client.capture({ distinctId: input.distinctId, event: input.event, properties });
  } catch {
    /* analytics is best-effort */
  }
}

/** Test-only: inject a recorder (or null to force the no-op path). */
export function setAnalyticsClientForTests(client: AnalyticsClient | null | undefined): void {
  testOverrideClient = client;
}
