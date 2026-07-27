import assert from "node:assert/strict";
import test from "node:test";
import {
  CLICK_ID_COOKIE,
  SIGNUP_ATTRIBUTION_COOKIE,
  readClickIdsFromCookieHeader,
  readSignupAttributionFromCookieHeader,
} from "./signup-click-ids.js";

function attributionCookie(payload: unknown): string {
  return `${SIGNUP_ATTRIBUTION_COOKIE}=${encodeURIComponent(JSON.stringify(payload))}`;
}

test("reads and JSON-decodes the click-id cookie", () => {
  const value = encodeURIComponent(JSON.stringify({ twclid: "tw123", gclid: "gg456" }));
  const header = `session=abc; ${CLICK_ID_COOKIE}=${value}; other=1`;
  assert.deepEqual(readClickIdsFromCookieHeader(header), { twclid: "tw123", gclid: "gg456" });
});

test("returns empty for a missing cookie, empty header, or nullish input", () => {
  assert.deepEqual(readClickIdsFromCookieHeader("session=abc"), {});
  assert.deepEqual(readClickIdsFromCookieHeader(""), {});
  assert.deepEqual(readClickIdsFromCookieHeader(null), {});
  assert.deepEqual(readClickIdsFromCookieHeader(undefined), {});
});

test("tolerates malformed cookie contents without throwing", () => {
  assert.deepEqual(readClickIdsFromCookieHeader(`${CLICK_ID_COOKIE}=%7Bnot-json`), {});
  assert.deepEqual(readClickIdsFromCookieHeader(`${CLICK_ID_COOKIE}=`), {});
});

test("drops non-string values from a tampered cookie", () => {
  const value = encodeURIComponent(JSON.stringify({ twclid: "tw123", evil: { x: 1 }, n: 5 }));
  assert.deepEqual(readClickIdsFromCookieHeader(`${CLICK_ID_COOKIE}=${value}`), {
    twclid: "tw123",
  });
});

test("reads attribution props, click ids, and posthog ids from the attribution cookie", () => {
  const header = attributionCookie({
    props: {
      utm_source: "x",
      utm_medium: "paid_social",
      utm_campaign: "first_campaign",
      referring_domain: "t.co",
      landing_path: "/",
      auth_method: "google",
      twclid: "tw123",
    },
    ph: { did: "anon-123", sid: "sess-456" },
  });
  const got = readSignupAttributionFromCookieHeader(header);
  assert.deepEqual(got.eventProperties, {
    utm_source: "x",
    utm_medium: "paid_social",
    utm_campaign: "first_campaign",
    referring_domain: "t.co",
    landing_path: "/",
    auth_method: "google",
    twclid: "tw123",
  });
  assert.deepEqual(got.clickIds, { twclid: "tw123" });
  assert.equal(got.posthogDistinctId, "anon-123");
  assert.equal(got.posthogSessionId, "sess-456");
});

test("attribution cookie drops unknown keys, non-strings, and oversized values", () => {
  const header = attributionCookie({
    props: {
      utm_source: "x",
      not_allowlisted: "nope",
      $set: "evil",
      evil_obj: { a: 1 },
      utm_term: "x".repeat(300),
    },
    ph: { did: 42, sid: "s\nid" },
  });
  const got = readSignupAttributionFromCookieHeader(header);
  assert.deepEqual(got.eventProperties, { utm_source: "x" });
  assert.equal(got.posthogDistinctId, undefined);
  assert.equal(got.posthogSessionId, undefined);
});

test("attribution cookie tolerates malformed contents and missing sections", () => {
  assert.deepEqual(readSignupAttributionFromCookieHeader(`${SIGNUP_ATTRIBUTION_COOKIE}=%7Bnope`), {
    eventProperties: {},
    clickIds: {},
  });
  const propsOnly = readSignupAttributionFromCookieHeader(attributionCookie({ props: { gclid: "g1" } }));
  assert.deepEqual(propsOnly.eventProperties, { gclid: "g1" });
  assert.deepEqual(propsOnly.clickIds, { gclid: "g1" });
  const phOnly = readSignupAttributionFromCookieHeader(attributionCookie({ ph: { sid: "sess-1" } }));
  assert.deepEqual(phOnly.eventProperties, {});
  assert.equal(phOnly.posthogSessionId, "sess-1");
});

test("legacy click-id cookie fills click ids when the attribution cookie lacks them", () => {
  const legacy = encodeURIComponent(JSON.stringify({ twclid: "tw-legacy" }));
  const header = `${CLICK_ID_COOKIE}=${legacy}; ${attributionCookie({ props: { utm_source: "x" }, ph: { sid: "sess-1" } })}`;
  const got = readSignupAttributionFromCookieHeader(header);
  assert.deepEqual(got.clickIds, { twclid: "tw-legacy" });
  assert.deepEqual(got.eventProperties, { utm_source: "x" });
});

test("legacy click-id cookie alone still yields click ids", () => {
  const legacy = encodeURIComponent(JSON.stringify({ gclid: "gg1" }));
  const got = readSignupAttributionFromCookieHeader(`${CLICK_ID_COOKIE}=${legacy}`);
  assert.deepEqual(got.clickIds, { gclid: "gg1" });
  assert.deepEqual(got.eventProperties, {});
});
