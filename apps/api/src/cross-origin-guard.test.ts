import assert from "node:assert/strict";
import test from "node:test";
import { isForbiddenCrossOriginRequest } from "./cross-origin-guard.js";

const allowed = ["https://telemetry.superlog.sh", "https://api.superlog.sh"];

function req(method: string, headers: Record<string, string>) {
  return { method, header: (name: string) => headers[name.toLowerCase()] };
}

test("a cookie-bearing POST from a sibling origin is refused", () => {
  assert.equal(
    isForbiddenCrossOriginRequest(
      req("POST", { cookie: "s=1", origin: "https://docs.superlog.sh" }),
      allowed,
    ),
    true,
  );
});

test("a cookie-bearing POST with Origin: null is refused", () => {
  assert.equal(
    isForbiddenCrossOriginRequest(req("POST", { cookie: "s=1", origin: "null" }), allowed),
    true,
  );
});

test("a cookie-bearing POST from an allowed web origin passes", () => {
  assert.equal(
    isForbiddenCrossOriginRequest(
      req("POST", { cookie: "s=1", origin: "https://telemetry.superlog.sh" }),
      allowed,
    ),
    false,
  );
});

test("without Origin, a same-site fetch is refused by Sec-Fetch-Site", () => {
  assert.equal(
    isForbiddenCrossOriginRequest(
      req("DELETE", { cookie: "s=1", "sec-fetch-site": "same-site" }),
      allowed,
    ),
    true,
  );
  assert.equal(
    isForbiddenCrossOriginRequest(
      req("PUT", { cookie: "s=1", "sec-fetch-site": "same-origin" }),
      allowed,
    ),
    false,
  );
});

test("requests without cookies (bearer clients, webhooks) are not checked", () => {
  assert.equal(
    isForbiddenCrossOriginRequest(req("POST", { origin: "https://evil.example" }), allowed),
    false,
  );
});

test("safe methods are not checked", () => {
  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    assert.equal(
      isForbiddenCrossOriginRequest(
        req(method, { cookie: "s=1", origin: "https://docs.superlog.sh" }),
        allowed,
      ),
      false,
    );
  }
});
