// First-touch signup attribution.
//
// We want PostHog to be able to answer "how many signups, and where did they
// come from?". Two kinds of "where from" are captured here:
//   - `source`: our own first-party tag (?source=skill|web|mcp|github|cli),
//     the same value the API persists on `orgs.signup_source`.
//   - UTM params + referrer: standard marketing attribution.
//
// The values are read at landing time and stashed in localStorage so they
// survive the OAuth redirect round-trip and the multi-step onboarding wizard.
// The actual PostHog event is fired once the user creates their first org (the
// canonical "new account" moment — see useCreateMyFirstOrg), which covers email
// and social signups uniformly.

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

  return omitEmpty({
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

function omitEmpty(attr: SignupAttribution): SignupAttribution {
  const out: SignupAttribution = {};
  for (const [k, v] of Object.entries(attr)) {
    if (v !== undefined && v !== null && v !== "") out[k as keyof SignupAttribution] = v;
  }
  return out;
}

function isEmpty(attr: SignupAttribution): boolean {
  return Object.keys(omitEmpty(attr)).length === 0;
}

/**
 * Persist attribution write-once: the first non-empty touch wins and is never
 * overwritten, so a user who lands via `?source=skill` and later navigates to a
 * plain URL keeps the original attribution.
 */
export function persistFirstTouchAttribution(storage: StorageLike, attr: SignupAttribution): void {
  const cleaned = omitEmpty(attr);
  if (isEmpty(cleaned)) return;
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
    return parsed && typeof parsed === "object" ? (parsed as SignupAttribution) : null;
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
