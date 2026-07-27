// Server side of the signup-attribution carriers. The web writes two
// first-party cookies so attribution survives the sign-up request — including
// the OAuth redirect to this API origin, which localStorage cannot cross:
//
// - `sl_click_ids` (legacy): ad-network click ids only, forwarded on the
//   vendor-neutral lifecycle event for conversion sinks.
// - `sl_signup_attr`: the full first-touch attribution as snake_case event
//   properties, plus the browser's PostHog distinct/session ids. The
//   user-create hook puts these on the server-side signup analytics event so
//   channel/session attribution exists at ingestion time instead of waiting
//   for the SPA to identify() later.
//
// Cookie names must match the web (`apps/web/src/signupAttribution.ts`). Both
// cookies are user-writable, so everything read here is allowlisted, type- and
// length-checked, and malformed input degrades to empty rather than throwing.

export const CLICK_ID_COOKIE = "sl_click_ids";
export const SIGNUP_ATTRIBUTION_COOKIE = "sl_signup_attr";

/** Decode one cookie's JSON value out of a raw `Cookie` header, or null. */
function readJsonCookie(header: string | null | undefined, name: string): unknown {
  if (!header) return null;
  const prefix = `${name}=`;
  const cookie = header
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(prefix));
  if (!cookie) return null;
  try {
    const raw = decodeURIComponent(cookie.slice(prefix.length));
    if (!raw) return null;
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/**
 * Parse the click-id cookie out of a raw `Cookie` request header. Best-effort
 * and defensive: the cookie is user-writable, so anything malformed or of the
 * wrong type is dropped and an empty map is returned rather than thrown.
 */
export function readClickIdsFromCookieHeader(
  header: string | null | undefined,
): Record<string, string> {
  const parsed = readJsonCookie(header, CLICK_ID_COOKIE);
  if (!parsed || typeof parsed !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === "string" && v !== "") out[k] = v;
  }
  return out;
}

// Event-property keys the attribution cookie may set on the signup analytics
// event. Mirrors the web's buildSignupEventProperties output; anything else in
// a (user-writable) cookie is dropped so a tampered cookie can't inject
// reserved PostHog keys like $set.
const ATTRIBUTION_EVENT_PROPERTY_KEYS = [
  "signup_source",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "referrer",
  "referring_domain",
  "landing_path",
  "auth_method",
  "twclid",
  "gclid",
  "fbclid",
  "msclkid",
  "li_fat_id",
] as const;

// Subset of the above that are ad-network click ids, forwarded to conversion
// sinks via the lifecycle event. Keyed by their standard query-param names.
const CLICK_ID_KEYS = ["twclid", "gclid", "fbclid", "msclkid", "li_fat_id"] as const;

const MAX_ATTRIBUTION_VALUE_LENGTH = 256;
// PostHog distinct/session ids are UUID-sized; anything much longer or with
// control characters is not a plausible id.
const POSTHOG_ID_RE = /^[\x21-\x7e]{1,128}$/;

export type SignupAttribution = {
  /** Allowlisted snake_case properties for the signup analytics event. */
  eventProperties: Record<string, string>;
  /** Ad-network click ids for the lifecycle-event conversion sinks. */
  clickIds: Record<string, string>;
  /** The browser's anonymous PostHog distinct id, to merge at signup. */
  posthogDistinctId?: string;
  /** The browser's PostHog session id, to session-attribute the signup. */
  posthogSessionId?: string;
};

function cleanAttributionValue(v: unknown): string | undefined {
  if (typeof v !== "string" || v === "" || v.length > MAX_ATTRIBUTION_VALUE_LENGTH) {
    return undefined;
  }
  return v;
}

function cleanPosthogId(v: unknown): string | undefined {
  return typeof v === "string" && POSTHOG_ID_RE.test(v) ? v : undefined;
}

/**
 * Read the full signup attribution out of a raw `Cookie` request header:
 * event properties + PostHog ids from `sl_signup_attr`, click ids from the
 * same, falling back to the legacy `sl_click_ids` cookie for clients that
 * only wrote that one. Never throws; missing/malformed input yields empties.
 */
export function readSignupAttributionFromCookieHeader(
  header: string | null | undefined,
): SignupAttribution {
  const out: SignupAttribution = { eventProperties: {}, clickIds: {} };

  const parsed = readJsonCookie(header, SIGNUP_ATTRIBUTION_COOKIE);
  if (parsed && typeof parsed === "object") {
    const { props, ph } = parsed as { props?: unknown; ph?: unknown };
    if (props && typeof props === "object") {
      for (const key of ATTRIBUTION_EVENT_PROPERTY_KEYS) {
        const v = cleanAttributionValue((props as Record<string, unknown>)[key]);
        if (v !== undefined) out.eventProperties[key] = v;
      }
    }
    if (ph && typeof ph === "object") {
      out.posthogDistinctId = cleanPosthogId((ph as Record<string, unknown>).did);
      out.posthogSessionId = cleanPosthogId((ph as Record<string, unknown>).sid);
    }
  }

  for (const key of CLICK_ID_KEYS) {
    const v = out.eventProperties[key];
    if (v !== undefined) out.clickIds[key] = v;
  }
  if (Object.keys(out.clickIds).length === 0) {
    out.clickIds = readClickIdsFromCookieHeader(header);
  }

  return out;
}
