import type { MiddlewareHandler } from "hono";

// Auth cookie scope.
//
// Auth cookies are host-only and carry the `__Host-` prefix: the browser sends
// them only to the API host, and no other subdomain can set or overwrite them.
// The web app reaches the API with credentialed fetches, which carry host-only
// cookies because web and API are same-site.
//
// Earlier builds scoped these cookies to the parent domain shared by web and
// API (`Domain=.<parent>`), so every sibling host received them. Those cookies
// are not read any more; `expireLegacyAuthCookies` deletes them from browsers
// that still send them.

export const AUTH_COOKIE_PREFIX = "superlog";
const LEGACY_PREFIX = "__Secure-better-auth.";

export type AuthCookieOptions =
  | Record<string, never>
  | {
      useSecureCookies: false;
      cookiePrefix: string;
      defaultCookieAttributes: { secure: true; sameSite: "lax"; path: "/" };
    };

export function authCookieOptions(apiOrigin: string): AuthCookieOptions {
  let https = false;
  try {
    https = new URL(apiOrigin).protocol === "https:";
  } catch {
    https = false;
  }
  if (!https) return {};
  // Better Auth always prepends `__Secure-` when it decides cookies are secure.
  // Turning that off and naming the prefix ourselves yields `__Host-` names;
  // the attributes below keep them Secure with Path=/ and no Domain.
  return {
    useSecureCookies: false,
    cookiePrefix: `__Host-${AUTH_COOKIE_PREFIX}`,
    defaultCookieAttributes: { secure: true, sameSite: "lax", path: "/" },
  };
}

// The parent domain earlier builds put on auth cookies. Only used to expire
// those cookies.
export function legacySharedCookieDomain(apiOrigin: string, webOrigin: string): string | undefined {
  try {
    const apiHost = new URL(apiOrigin).hostname;
    const webHost = new URL(webOrigin).hostname;
    if (apiHost === webHost) return undefined;
    if (apiHost === "localhost" || webHost === "localhost") return undefined;
    if (apiHost.endsWith(".localhost") || webHost.endsWith(".localhost")) return undefined;
    const a = apiHost.split(".");
    const b = webHost.split(".");
    const parts: string[] = [];
    while (a.length && b.length && a[a.length - 1] === b[b.length - 1]) {
      parts.unshift(a.pop() as string);
      b.pop();
    }
    if (parts.length < 2) return undefined;
    return `.${parts.join(".")}`;
  } catch {
    return undefined;
  }
}

function cookieNames(header: string): string[] {
  const names: string[] = [];
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq > 0) names.push(trimmed.slice(0, eq));
  }
  return names;
}

// Set-Cookie headers that delete every parent-domain auth cookie the request
// carried. Never copies them: any sibling host can set a parent-domain cookie.
export function expiredLegacyAuthCookies(
  cookieHeader: string | null | undefined,
  legacyDomain: string | undefined,
): string[] {
  if (!cookieHeader) return [];
  const domain = legacyDomain ? `; Domain=${legacyDomain}` : "";
  return [
    ...new Set(cookieNames(cookieHeader).filter((name) => name.startsWith(LEGACY_PREFIX))),
  ].map((name) => `${name}=; Max-Age=0${domain}; Path=/; HttpOnly; Secure; SameSite=Lax`);
}

export function expireLegacyAuthCookies(legacyDomain: string | undefined): MiddlewareHandler {
  return async (c, next) => {
    const expired = expiredLegacyAuthCookies(c.req.header("cookie"), legacyDomain);
    await next();
    for (const cookie of expired) c.res.headers.append("set-cookie", cookie);
  };
}
