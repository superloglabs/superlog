import type { MiddlewareHandler } from "hono";

// Cross-site request protection for cookie-authenticated writes.
//
// SameSite=Lax keeps cookies off cross-site POSTs, but every subdomain of the
// same registrable domain is "same-site", so a page on any sibling host could
// send a credentialed write with a simple content type (no CORS preflight).
// Browsers always send Origin on non-GET requests, so a write that carries a
// session cookie must come from a trusted origin.
//
// Requests without a session cookie (API keys, webhooks, OAuth token calls)
// are not ambient-credentialed and are not affected.

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function hasSessionCookie(cookieHeader: string | null | undefined): boolean {
  if (!cookieHeader) return false;
  for (const part of cookieHeader.split(";")) {
    const name = part.split("=", 1)[0]?.trim() ?? "";
    if (/(^|\.)(session_token|session_data)$/.test(name)) return true;
  }
  return false;
}

export function isUntrustedCookieWrite(input: {
  method: string;
  cookieHeader: string | null | undefined;
  origin: string | null | undefined;
  secFetchSite: string | null | undefined;
  trustedOrigins: readonly string[];
}): boolean {
  if (SAFE_METHODS.has(input.method.toUpperCase())) return false;
  if (!hasSessionCookie(input.cookieHeader)) return false;
  if (input.origin) return !input.trustedOrigins.includes(input.origin);
  if (input.secFetchSite)
    return input.secFetchSite !== "same-origin" && input.secFetchSite !== "none";
  return false;
}

export function cookieWriteOriginGuard(trustedOrigins: readonly string[]): MiddlewareHandler {
  return async (c, next) => {
    if (
      isUntrustedCookieWrite({
        method: c.req.method,
        cookieHeader: c.req.header("cookie"),
        origin: c.req.header("origin"),
        secFetchSite: c.req.header("sec-fetch-site"),
        trustedOrigins,
      })
    ) {
      return c.json({ error: "forbidden origin" }, 403);
    }
    return next();
  };
}
