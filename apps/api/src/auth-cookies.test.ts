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
