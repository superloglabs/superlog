import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import {
  AUTH_COOKIE_PREFIX,
  authCookieOptions,
  expireLegacyAuthCookies,
  expiredLegacyAuthCookies,
  legacySharedCookieDomain,
} from "./auth-cookies.js";

const LEGACY = "__Secure-better-auth";
const CURRENT = `__Host-${AUTH_COOKIE_PREFIX}`;

test("https deployments use host-only __Host- auth cookies", () => {
  const options = authCookieOptions("https://api.example.com");
  assert.deepEqual(options, {
    useSecureCookies: false,
    cookiePrefix: CURRENT,
    defaultCookieAttributes: { secure: true, sameSite: "lax", path: "/" },
  });
  assert.equal("crossSubDomainCookies" in options, false);
});

test("plain-http local deployments keep Better Auth's defaults", () => {
  assert.deepEqual(authCookieOptions("http://localhost:4100"), {});
});

test("the legacy shared cookie domain is the parent domain of web and api", () => {
  assert.equal(
    legacySharedCookieDomain("https://api.example.com", "https://app.example.com"),
    ".example.com",
  );
  assert.equal(legacySharedCookieDomain("https://example.com", "https://example.com"), undefined);
  assert.equal(
    legacySharedCookieDomain("http://localhost:4100", "http://localhost:5173"),
    undefined,
  );
  assert.equal(
    legacySharedCookieDomain("https://api.wt.app.localhost", "https://wt.app.localhost"),
    undefined,
  );
});

test("every legacy auth cookie is expired on the parent domain and never copied", () => {
  assert.deepEqual(
    expiredLegacyAuthCookies(
      `theme=dark; ${LEGACY}.session_token=tok; ${CURRENT}.session_token=new; ${LEGACY}.state=st`,
      ".example.com",
    ),
    [
      `${LEGACY}.session_token=; Max-Age=0; Domain=.example.com; Path=/; HttpOnly; Secure; SameSite=Lax`,
      `${LEGACY}.state=; Max-Age=0; Domain=.example.com; Path=/; HttpOnly; Secure; SameSite=Lax`,
    ],
  );
});

test("requests without legacy cookies get nothing", () => {
  assert.deepEqual(expiredLegacyAuthCookies(`${CURRENT}.session_token=new`, ".example.com"), []);
  assert.deepEqual(expiredLegacyAuthCookies(undefined, ".example.com"), []);
});

// End to end with Better Auth itself, so a library upgrade that changes how
// cookie names or attributes are built fails here.
async function betterAuthWith(advanced: Record<string, unknown>) {
  const { betterAuth } = await import("better-auth");
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  return betterAuth({
    baseURL: "https://api.example.com",
    secret: "test-secret-that-is-long-enough-for-better-auth",
    trustedOrigins: ["https://app.example.com"],
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    emailAndPassword: { enabled: true },
    session: { expiresIn: 604800 },
    advanced,
  });
}

function sessionCookie(response: Response, name: string): string | undefined {
  return response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`));
}

test("Better Auth issues host-only __Host- session cookies with these options", async () => {
  const auth = await betterAuthWith({ ...authCookieOptions("https://api.example.com") });
  const response = await auth.handler(
    new Request("https://api.example.com/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://app.example.com" },
      body: JSON.stringify({ email: "user@example.com", password: "password-123", name: "User" }),
    }),
  );
  assert.equal(response.status, 200);
  const cookie = sessionCookie(response, `${CURRENT}.session_token`);
  assert.ok(cookie, response.headers.getSetCookie().join("\n"));
  assert.match(cookie, /; Secure/i);
  assert.match(cookie, /; Path=\//i);
  assert.doesNotMatch(cookie, /Domain=/i);
});

test("a legacy parent-domain session no longer authenticates and its cookie is expired", async () => {
  const legacyAuth = await betterAuthWith({
    crossSubDomainCookies: { enabled: true, domain: ".example.com" },
    defaultCookieAttributes: { sameSite: "lax", secure: true },
  });
  const signUp = await legacyAuth.handler(
    new Request("https://api.example.com/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://app.example.com" },
      body: JSON.stringify({ email: "user@example.com", password: "password-123", name: "User" }),
    }),
  );
  const legacyCookie = sessionCookie(signUp, `${LEGACY}.session_token`);
  assert.ok(legacyCookie);
  assert.match(legacyCookie, /Domain=\.example\.com/i);
  const legacyPair = legacyCookie.split(";")[0] ?? "";

  // Same database and secret, new cookie options: the deployed change.
  const { betterAuth } = await import("better-auth");
  const currentAuth = betterAuth({
    ...legacyAuth.options,
    advanced: { ...authCookieOptions("https://api.example.com") },
  });
  const app = new Hono();
  app.use("*", expireLegacyAuthCookies(".example.com"));
  app.get("/api/me", async (c) => {
    const session = await currentAuth.api.getSession({ headers: c.req.raw.headers });
    return c.json({ email: session?.user.email ?? null });
  });

  const response = await app.request("/api/me", { headers: { cookie: legacyPair } });
  assert.deepEqual(await response.json(), { email: null });
  assert.deepEqual(
    response.headers.getSetCookie().filter((c) => c.startsWith(`${CURRENT}.`)),
    [],
  );
  assert.ok(
    response.headers
      .getSetCookie()
      .some((c) => c.startsWith(`${LEGACY}.session_token=;`) && /Domain=\.example\.com/.test(c)),
  );
});
