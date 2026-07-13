// First-touch signup attribution.
//
// We want PostHog to be able to answer "how many signups, and where did they
// come from?". Two kinds of "where from" are captured here:
//   - `source`: our own first-party tag (?source=skill|web|mcp|github|cli),
//     the same value the API persists on `orgs.signup_source`.
//   - UTM params + referrer: standard marketing attribution.
//
// The values are read at landing time and stashed in localStorage so they
// survive the OAuth redirect round-trip and the multi-step onboarding wizard,
// then attached to the PostHog person as $set_once on identify (see
// PostHogUserSync in App.tsx). The signup count itself is emitted server-side
// (the API's user-create hook), so attribution rides on the person and stays
// queryable — via person-on-events — on the server-side signup event.

export type SignupAttribution = {
  source?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmTerm?: string;
  utmContent?: string;
  referrer?: string;
  referringDomain?: string;
  landingPath?: string;
};

// Kept in sync with the API's ALLOWED_SIGNUP_SOURCES validation shape: a short
// slug of lower-case letters/digits/_/-. We normalize case but otherwise pass
// the raw value through (the API enforces the allow-list server-side).
const SOURCE_RE = /^[a-z0-9_-]{1,32}$/;

// A minimal slice of the Web Storage API so callers can pass `window.localStorage`
// and tests can pass an in-memory stand-in.
export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export const FIRST_TOUCH_STORAGE_KEY = "superlog.signup_attribution";

function cleanParam(value: string | null): string | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 256 ? trimmed : undefined;
}

/** Parse attribution from a URL query string and the document referrer. Pure. */
export function parseAttribution(search: string, referrer: string): SignupAttribution {
  const params = new URLSearchParams(search);

  const rawSource = params.get("source")?.trim().toLowerCase();
  const source = rawSource && SOURCE_RE.test(rawSource) ? rawSource : undefined;

  let referringDomain: string | undefined;
  const ref = cleanParam(referrer);
  if (ref) {
    try {
      referringDomain = new URL(ref).hostname || undefined;
    } catch {
      /* malformed referrer — leave the domain undefined */
    }
  }

  return sanitize({
    source,
    utmSource: cleanParam(params.get("utm_source")),
    utmMedium: cleanParam(params.get("utm_medium")),
    utmCampaign: cleanParam(params.get("utm_campaign")),
    utmTerm: cleanParam(params.get("utm_term")),
    utmContent: cleanParam(params.get("utm_content")),
    referrer: ref,
    referringDomain,
  });
}

const ATTRIBUTION_KEYS = [
  "source",
  "utmSource",
  "utmMedium",
  "utmCampaign",
  "utmTerm",
  "utmContent",
  "referrer",
  "referringDomain",
  "landingPath",
] as const;

// `landingPath` is context that rides along with a real touch, not a touch in
// its own right — it's always present (pathname is at least "/"), so counting it
// as signal would lock in first-touch on the very first pageview and shut out a
// later ?source=/UTM landing. Gate persistence on everything else.
const SIGNAL_KEYS = ATTRIBUTION_KEYS.filter((k) => k !== "landingPath");

/** Keep only known keys whose value is a non-empty string. */
function sanitize(attr: SignupAttribution): SignupAttribution {
  const out: SignupAttribution = {};
  for (const key of ATTRIBUTION_KEYS) {
    const v = attr[key];
    if (typeof v === "string" && v !== "") out[key] = v;
  }
  return out;
}

function hasAttributionSignal(attr: SignupAttribution): boolean {
  return SIGNAL_KEYS.some((k) => typeof attr[k] === "string" && attr[k] !== "");
}

/**
 * Persist attribution write-once: the first touch carrying real signal (source,
 * UTM, or referrer) wins and is never overwritten, so a user who lands via
 * `?source=skill` and later navigates to a plain URL keeps the original
 * attribution. A pageview with no signal is not persisted, so it can't lock in
 * a `landingPath`-only record and shut out a later attributed landing.
 */
export function persistFirstTouchAttribution(storage: StorageLike, attr: SignupAttribution): void {
  const cleaned = sanitize(attr);
  if (!hasAttributionSignal(cleaned)) return;
  try {
    if (storage.getItem(FIRST_TOUCH_STORAGE_KEY)) return;
    storage.setItem(FIRST_TOUCH_STORAGE_KEY, JSON.stringify(cleaned));
  } catch {
    /* storage unavailable (private mode, quota) — attribution is best-effort */
  }
}

export function readFirstTouchAttribution(storage: StorageLike): SignupAttribution | null {
  try {
    const raw = storage.getItem(FIRST_TOUCH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Storage is user-writable; sanitize so non-string values can't leak past
    // the Record<string, string> typing into event properties downstream.
    if (!parsed || typeof parsed !== "object") return null;
    return sanitize(parsed as SignupAttribution);
  } catch {
    return null;
  }
}

export type SignupEventContext = {
  authMethod?: string;
};

/** Flatten attribution into snake_case PostHog event properties, omitting blanks. */
export function buildSignupEventProperties(
  attr: SignupAttribution,
  ctx: SignupEventContext,
): Record<string, string> {
  const props: Record<string, string | undefined> = {
    signup_source: attr.source,
    utm_source: attr.utmSource,
    utm_medium: attr.utmMedium,
    utm_campaign: attr.utmCampaign,
    utm_term: attr.utmTerm,
    utm_content: attr.utmContent,
    referrer: attr.referrer,
    referring_domain: attr.referringDomain,
    landing_path: attr.landingPath,
    auth_method: ctx.authMethod,
  };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(props)) {
    if (v !== undefined && v !== null && v !== "") out[k] = v;
  }
  return out;
}
