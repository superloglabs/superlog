import type { MiddlewareHandler } from "hono";

// Auth cookie scope.
//
// Auth cookies are host-only and carry the `__Host-` prefix: the browser sends
// them only to the API host, and no other subdomain can set or overwrite them.
// The web app reaches the API with credentialed fetches, which carry host-only
// cookies because web and API are same-site.
//
// Earlier builds scoped these cookies to the parent domain shared by web and
// API (`Domain=.<parent>`), so every sibling host received them.
// `legacyAuthCookieMigration` moves those cookies to the host-only names on
// the next request and expires the parent-domain copies.

export const AUTH_COOKIE_PREFIX = "superlog";
const HOST_PREFIX = `__Host-${AUTH_COOKIE_PREFIX}.`;
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

export type LegacyCookieMigrationOptions = {
  legacyDomain: string | undefined;
  sessionMaxAgeSeconds: number;
};

type CookiePair = { name: string; value: string };

function parseCookiePairs(header: string): CookiePair[] {
  const pairs: CookiePair[] = [];
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    pairs.push({ name: trimmed.slice(0, eq), value: trimmed.slice(eq + 1) });
  }
  return pairs;
}

const ATTRIBUTES = "Path=/; HttpOnly; Secure; SameSite=Lax";

// Pure planning step: rewrites the request's Cookie header so this request
// authenticates with the host-only names, and lists the Set-Cookie headers
// that make the browser do the same. Returns null when there is nothing to do.
export function migrateLegacyAuthCookies(
  cookieHeader: string | null | undefined,
  options: LegacyCookieMigrationOptions,
): { cookieHeader: string; setCookies: string[] } | null {
  if (!cookieHeader) return null;
  const pairs = parseCookiePairs(cookieHeader);
  if (!pairs.some((p) => p.name.startsWith(LEGACY_PREFIX))) return null;

  const current = new Set(pairs.filter((p) => p.name.startsWith(HOST_PREFIX)).map((p) => p.name));
  const sessionOnly = pairs.some(
    (p) => p.name === `${LEGACY_PREFIX}dont_remember` || p.name === `${HOST_PREFIX}dont_remember`,
  );
  const domain = options.legacyDomain ? `; Domain=${options.legacyDomain}` : "";

  const kept: string[] = [];
  const setCookies: string[] = [];
  for (const pair of pairs) {
    if (!pair.name.startsWith(LEGACY_PREFIX)) {
      kept.push(`${pair.name}=${pair.value}`);
      continue;
    }
    const target = `${HOST_PREFIX}${pair.name.slice(LEGACY_PREFIX.length)}`;
    if (!current.has(target)) {
      current.add(target);
      kept.push(`${target}=${pair.value}`);
      const maxAge =
        target === `${HOST_PREFIX}session_token` && !sessionOnly
          ? `; Max-Age=${options.sessionMaxAgeSeconds}`
          : "";
      setCookies.push(`${target}=${pair.value}${maxAge}; ${ATTRIBUTES}`);
    }
    setCookies.push(`${pair.name}=; Max-Age=0${domain}; ${ATTRIBUTES}`);
  }
  return { cookieHeader: kept.join("; "), setCookies };
}

function setCookieName(header: string): string {
  const eq = header.indexOf("=");
  return eq > 0 ? header.slice(0, eq).trim() : header.trim();
}

export function legacyAuthCookieMigration(
  options: LegacyCookieMigrationOptions,
): MiddlewareHandler {
  return async (c, next) => {
    const plan = migrateLegacyAuthCookies(c.req.raw.headers.get("cookie"), options);
    if (!plan) return next();

    const headers = new Headers(c.req.raw.headers);
    if (plan.cookieHeader) headers.set("cookie", plan.cookieHeader);
    else headers.delete("cookie");
    c.req.raw = new Request(c.req.raw, { headers });

    await next();

    // A handler that sets an auth cookie itself (sign-in, sign-out, session
    // refresh) has the final say over that name.
    const alreadySet = new Set(c.res.headers.getSetCookie().map(setCookieName));
    for (const cookie of plan.setCookies) {
      if (alreadySet.has(setCookieName(cookie))) continue;
      c.res.headers.append("set-cookie", cookie);
    }
  };
}
