// Browser side of the signup-attribution carrier cookie. Reads the stashed
// first-touch attribution from localStorage, snapshots the live PostHog
// distinct/session ids, and writes both into a short-lived first-party cookie
// the API reads in its user-create hook. Written at landing and refreshed at
// auth time so the PostHog ids are current when the sign-up request happens —
// the session id rotates after 30 minutes of inactivity, so a landing-time
// snapshot alone can go stale before the user signs up.

import {
  SIGNUP_ATTRIBUTION_COOKIE,
  buildSignupEventProperties,
  readFirstTouchAttribution,
  serializeSignupAttributionCookie,
} from "./signupAttribution.ts";

// Long enough to survive landing → "Get started" → sign up (including an OAuth
// round-trip), then it expires on its own. Not a durable tracking cookie.
const COOKIE_MAX_AGE_SECONDS = 30 * 60;

// Optional parent domain so the cookie reaches the API on a sibling subdomain
// (e.g. api.example.com). Unset in dev / self-host → host-only, which is fine
// when web and api share a host.
const COOKIE_DOMAIN = import.meta.env.VITE_ATTRIBUTION_COOKIE_DOMAIN as string | undefined;

// The slice of posthog-js we read. Structural so callers can pass the
// uninitialized global instance (methods present but inert) or nothing at all.
type PosthogLike = {
  get_distinct_id?: () => string;
  get_session_id?: () => string;
} | null;

/**
 * Write (or refresh) the signup-attribution cookie. Unlike the legacy
 * click-id cookie this overwrites on every call: the attribution part is
 * already first-touch-stable via localStorage, and the PostHog ids must be
 * fresh at auth time. No-op outside a DOM or when there's nothing to carry.
 */
export function refreshSignupAttributionCookie(
  posthog: PosthogLike,
  opts: { authMethod?: string } = {},
): void {
  if (typeof document === "undefined") return;
  let attr = {};
  try {
    attr = readFirstTouchAttribution(window.localStorage) ?? {};
  } catch {
    /* storage unavailable — carry the PostHog ids alone */
  }
  const props = buildSignupEventProperties(attr, { authMethod: opts.authMethod });
  let distinctId: string | undefined;
  let sessionId: string | undefined;
  try {
    distinctId = posthog?.get_distinct_id?.();
    sessionId = posthog?.get_session_id?.();
  } catch {
    /* posthog not booted — attribution still rides without the ids */
  }
  const value = serializeSignupAttributionCookie(props, { distinctId, sessionId });
  if (!value) return;
  const parts = [
    `${SIGNUP_ATTRIBUTION_COOKIE}=${encodeURIComponent(value)}`,
    "path=/",
    `max-age=${COOKIE_MAX_AGE_SECONDS}`,
    "samesite=lax",
  ];
  if (COOKIE_DOMAIN) parts.push(`domain=${COOKIE_DOMAIN}`);
  if (typeof location !== "undefined" && location.protocol === "https:") parts.push("secure");
  document.cookie = parts.join("; ");
}
