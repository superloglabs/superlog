import assert from "node:assert/strict";
import test from "node:test";
import { CLICK_ID_COOKIE, readClickIdsFromCookieHeader } from "./signup-click-ids.js";

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
