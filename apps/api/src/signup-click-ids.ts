// Server side of the click-id attribution carrier. The web writes ad-network
// click ids (twclid, gclid, …) captured from the landing URL into a first-party
// cookie so they survive the sign-up request — including the OAuth redirect to
// this API origin, which localStorage cannot cross. The user-create hook reads
// them here and forwards them on the vendor-neutral lifecycle event; a
// deployment's sink then attaches whichever its ad network wants.
//
// Cookie name must match the web (`superlog/apps/web/src/signupAttribution.ts`).

export const CLICK_ID_COOKIE = "sl_click_ids";

/**
 * Parse the click-id cookie out of a raw `Cookie` request header. Best-effort
 * and defensive: the cookie is user-writable, so anything malformed or of the
 * wrong type is dropped and an empty map is returned rather than thrown.
 */
export function readClickIdsFromCookieHeader(
  header: string | null | undefined,
): Record<string, string> {
  if (!header) return {};
  const prefix = `${CLICK_ID_COOKIE}=`;
  const cookie = header
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(prefix));
  if (!cookie) return {};
  try {
    const raw = decodeURIComponent(cookie.slice(prefix.length));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string" && v !== "") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}
