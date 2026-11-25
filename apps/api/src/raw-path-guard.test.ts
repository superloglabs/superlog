import assert from "node:assert/strict";
import test from "node:test";
import { hasAmbiguousPathSegment } from "./raw-path-guard.js";

test("dot segments, encoded or not, are refused", () => {
  for (const raw of [
    "/api/x/%2e%2e/auth/sign-up/email",
    "/api/webhooks/%2E%2e/auth/sign-up/email",
    "/api/x/../auth/sign-up/email",
    "/api/x/.%2e/auth/sign-up/email",
    "/api/./auth/sign-up/email",
    "/api/x/%2e/auth",
    "/api/x%2fauth/sign-up/email",
    "/api/x%5c..%5cauth",
    "/api\\..\\auth",
    "//api/auth/sign-up/email",
    "/api/auth//sign-up/email",
  ]) {
    assert.equal(hasAmbiguousPathSegment(raw), true, raw);
  }
});

test("ordinary paths, dotted names, and query strings pass", () => {
  for (const raw of [
    "/api/auth/sign-up/email",
    "/.well-known/oauth-authorization-server",
    "/api/v1/projects/p/sourcemaps/app.min.js.map",
    "/api/projects/p/logs?q=../etc&next=%2e%2e",
    "/v1/traces",
    "/",
  ]) {
    assert.equal(hasAmbiguousPathSegment(raw), false, raw);
  }
});
