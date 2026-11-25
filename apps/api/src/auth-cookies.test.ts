import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import {
  AUTH_COOKIE_PREFIX,
  authCookieOptions,
  legacyAuthCookieMigration,
  legacySharedCookieDomain,
  migrateLegacyAuthCookies,
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

test("legacy cookies are copied to host-only names and expired on the parent domain", () => {
  const result = migrateLegacyAuthCookies(
    `theme=dark; ${LEGACY}.session_token=tok.sig%3D; ${LEGACY}.state=st`,
    { legacyDomain: ".example.com", sessionMaxAgeSeconds: 604800 },
  );
  assert.deepEqual(result, {
    cookieHeader: `theme=dark; ${CURRENT}.session_token=tok.sig%3D; ${CURRENT}.state=st`,
    setCookies: [
      `${CURRENT}.session_token=tok.sig%3D; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax`,
      `${LEGACY}.session_token=; Max-Age=0; Domain=.example.com; Path=/; HttpOnly; Secure; SameSite=Lax`,
      `${CURRENT}.state=st; Path=/; HttpOnly; Secure; SameSite=Lax`,
      `${LEGACY}.state=; Max-Age=0; Domain=.example.com; Path=/; HttpOnly; Secure; SameSite=Lax`,
    ],
  });
});

test("a session-only legacy login stays session-only after the copy", () => {
  const result = migrateLegacyAuthCookies(
    `${LEGACY}.session_token=tok; ${LEGACY}.dont_remember=true`,
    { legacyDomain: ".example.com", sessionMaxAgeSeconds: 604800 },
  );
  assert.ok(result);
  assert.ok(
    result.setCookies.includes(
      `${CURRENT}.session_token=tok; Path=/; HttpOnly; Secure; SameSite=Lax`,
    ),
  );
});

test("a current cookie wins over a legacy one and the legacy one is only expired", () => {
  const result = migrateLegacyAuthCookies(
    `${LEGACY}.session_token=old; ${CURRENT}.session_token=new`,
    { legacyDomain: ".example.com", sessionMaxAgeSeconds: 604800 },
  );
  assert.deepEqual(result, {
    cookieHeader: `${CURRENT}.session_token=new`,
    setCookies: [
      `${LEGACY}.session_token=; Max-Age=0; Domain=.example.com; Path=/; HttpOnly; Secure; SameSite=Lax`,
    ],
  });
});

test("requests without legacy cookies are left alone", () => {
  assert.equal(
    migrateLegacyAuthCookies(`${CURRENT}.session_token=new; theme=dark`, {
      legacyDomain: ".example.com",
      sessionMaxAgeSeconds: 604800,
    }),
    null,
  );
  assert.equal(
    migrateLegacyAuthCookies(undefined, { legacyDomain: ".example.com", sessionMaxAgeSeconds: 1 }),
    null,
  );
});

function migrationApp(seen: { cookie?: string | null }, setOnResponse?: string) {
  const app = new Hono();
  app.use(
    "*",
    legacyAuthCookieMigration({ legacyDomain: ".example.com", sessionMaxAgeSeconds: 604800 }),
  );
  app.all("*", (c) => {
    seen.cookie = c.req.raw.headers.get("cookie");
    const res = new Response("ok");
    if (setOnResponse) res.headers.append("set-cookie", setOnResponse);
    return res;
  });
  return app;
}

test("the middleware lets the current request authenticate with the copied cookie", async () => {
  const seen: { cookie?: string | null } = {};
  const res = await migrationApp(seen).request("/api/me", {
    method: "POST",
    headers: { cookie: `${LEGACY}.session_token=tok` },
    body: "{}",
  });
  assert.equal(seen.cookie, `${CURRENT}.session_token=tok`);
  const setCookies = res.headers.getSetCookie();
  assert.equal(setCookies.length, 2);
  assert.match(setCookies[0] ?? "", new RegExp(`^${CURRENT}\\.session_token=tok;`));
  assert.match(setCookies[1] ?? "", /Domain=\.example\.com/);
});

test("the middleware never overrides a cookie the handler set, e.g. sign-out", async () => {
  const signOut = `${CURRENT}.session_token=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
  const res = await migrationApp({}, signOut).request("/api/auth/sign-out", {
    method: "POST",
    headers: { cookie: `${LEGACY}.session_token=tok` },
  });
  const setCookies = res.headers.getSetCookie();
  assert.deepEqual(
    setCookies.filter((c) => c.startsWith(`${CURRENT}.session_token=`)),
    [signOut],
  );
  assert.ok(setCookies.some((c) => c.startsWith(`${LEGACY}.session_token=;`)));
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

test("a session from a legacy parent-domain cookie still authenticates after the move", async () => {
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
  const legacyValue = legacyCookie.split(";")[0]?.slice(`${LEGACY}.session_token=`.length);

  // Same database and secret, new cookie options: the deployed change.
  const { betterAuth } = await import("better-auth");
  const currentAuth = betterAuth({
    ...legacyAuth.options,
    advanced: { ...authCookieOptions("https://api.example.com") },
  });
  const app = new Hono();
  app.use(
    "*",
    legacyAuthCookieMigration({ legacyDomain: ".example.com", sessionMaxAgeSeconds: 604800 }),
  );
  app.get("/api/me", async (c) => {
    const session = await currentAuth.api.getSession({ headers: c.req.raw.headers });
    return c.json({ email: session?.user.email ?? null });
  });

  const response = await app.request("/api/me", {
    headers: { cookie: `${LEGACY}.session_token=${legacyValue}` },
  });
  assert.deepEqual(await response.json(), { email: "user@example.com" });
  const setCookies = response.headers.getSetCookie();
  assert.ok(setCookies.some((c) => c.startsWith(`${CURRENT}.session_token=${legacyValue};`)));
  assert.ok(
    setCookies.some(
      (c) => c.startsWith(`${LEGACY}.session_token=;`) && /Domain=\.example\.com/.test(c),
    ),
  );
});
