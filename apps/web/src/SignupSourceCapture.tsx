import { useEffect } from "react";
import {
  CLICK_ID_COOKIE,
  parseAttribution,
  persistFirstTouchAttribution,
  serializeClickIdsCookie,
} from "./signupAttribution.ts";

// How long the click-id cookie lives. Just long enough to survive landing →
// "Get started" → sign up (including an OAuth round-trip), then it expires on
// its own. Not a durable tracking cookie.
const CLICK_ID_COOKIE_MAX_AGE_SECONDS = 30 * 60;

// Optional parent domain so the cookie reaches the API on a sibling subdomain
// (e.g. api.example.com). Unset in dev / self-host → host-only, which is fine
// when web and api share a host.
const COOKIE_DOMAIN = import.meta.env.VITE_ATTRIBUTION_COOKIE_DOMAIN as string | undefined;

/**
 * Persist the click-id cookie first-touch (the ad click that brought the user
 * in wins; a later plain pageview never clobbers it). No-op when there are no
 * click ids or storage/cookies are unavailable.
 */
function writeClickIdCookie(value: string) {
  if (typeof document === "undefined") return;
  // First-touch: don't overwrite an existing click-id cookie.
  if (document.cookie.split("; ").some((c) => c.startsWith(`${CLICK_ID_COOKIE}=`))) return;
  const parts = [
    `${CLICK_ID_COOKIE}=${encodeURIComponent(value)}`,
    "path=/",
    `max-age=${CLICK_ID_COOKIE_MAX_AGE_SECONDS}`,
    "samesite=lax",
  ];
  if (COOKIE_DOMAIN) parts.push(`domain=${COOKIE_DOMAIN}`);
  if (typeof location !== "undefined" && location.protocol === "https:") parts.push("secure");
  document.cookie = parts.join("; ");
}

export function SignupSourceCapture() {
  useEffect(() => {
    const attr = parseAttribution(window.location.search, document.referrer);
    if (attr.source) {
      try {
        const existing = window.localStorage.getItem("superlog.signup_source");
        if (!existing) window.localStorage.setItem("superlog.signup_source", attr.source);
      } catch {
        // Attribution is best-effort when storage is unavailable.
      }
    }
    persistFirstTouchAttribution(window.localStorage, {
      ...attr,
      landingPath: window.location.pathname,
    });
    // Carry any ad-network click ids to the server for the sign-up conversion.
    const clickIds = serializeClickIdsCookie(attr);
    if (clickIds) writeClickIdCookie(clickIds);
  }, []);

  return null;
}
