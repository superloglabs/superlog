import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { cookieWriteOriginGuard, isUntrustedCookieWrite } from "./csrf-origin.js";

const trusted = ["https://app.example.com", "https://api.example.com"];
const session = "__Host-superlog.session_token=tok";

function check(input: {
  method?: string;
  cookie?: string;
  origin?: string;
  secFetchSite?: string;
}) {
  return isUntrustedCookieWrite({
    method: input.method ?? "POST",
    cookieHeader: input.cookie ?? session,
    origin: input.origin,
    secFetchSite: input.secFetchSite,
    trustedOrigins: trusted,
  });
}

test("cookie writes from the web app or the API itself are allowed", () => {
  assert.equal(check({ origin: "https://app.example.com" }), false);
  assert.equal(check({ origin: "https://api.example.com" }), false);
});

test("cookie writes from a sibling subdomain are rejected", () => {
  assert.equal(check({ origin: "https://docs.example.com", secFetchSite: "same-site" }), true);
  assert.equal(check({ origin: "https://docs.example.com" }), true);
  assert.equal(check({ method: "DELETE", origin: "https://docs.example.com" }), true);
  assert.equal(check({ method: "PATCH", origin: "https://evil.test" }), true);
});

test("an opaque null origin is rejected", () => {
  assert.equal(check({ origin: "null" }), true);
});

test("browser writes without Origin are judged by Sec-Fetch-Site", () => {
  assert.equal(check({ secFetchSite: "same-origin" }), false);
  assert.equal(check({ secFetchSite: "none" }), false);
  assert.equal(check({ secFetchSite: "same-site" }), true);
  assert.equal(check({ secFetchSite: "cross-site" }), true);
});

test("non-browser clients without Origin or Sec-Fetch-Site are not affected", () => {
  assert.equal(check({}), false);
});

test("reads and cookie-less requests are not affected", () => {
  assert.equal(check({ method: "GET", origin: "https://docs.example.com" }), false);
  assert.equal(check({ method: "HEAD", origin: "https://docs.example.com" }), false);
  assert.equal(check({ method: "OPTIONS", origin: "https://docs.example.com" }), false);
  assert.equal(check({ cookie: "", origin: "https://docs.example.com" }), false);
  assert.equal(check({ cookie: "theme=dark", origin: "https://docs.example.com" }), false);
});

test("legacy and local session cookie names count as credentials", () => {
  for (const cookie of [
    "__Secure-better-auth.session_token=tok",
    "better-auth.session_token=tok",
    "__Host-superlog.session_data=x",
  ]) {
    assert.equal(check({ cookie, origin: "https://docs.example.com" }), true, cookie);
  }
});

test("the guard answers 403 before the handler runs", async () => {
  const app = new Hono();
  let ran = false;
  app.use("*", cookieWriteOriginGuard(trusted));
  app.post("/api/orgs", (c) => {
    ran = true;
    return c.json({ ok: true });
  });
  const blocked = await app.request("/api/orgs", {
    method: "POST",
    headers: { cookie: session, origin: "https://docs.example.com", "content-type": "text/plain" },
    body: "{}",
  });
  assert.equal(blocked.status, 403);
  assert.equal(ran, false);
  const allowed = await app.request("/api/orgs", {
    method: "POST",
    headers: { cookie: session, origin: "https://app.example.com" },
    body: "{}",
  });
  assert.equal(allowed.status, 200);
  assert.equal(ran, true);
});
