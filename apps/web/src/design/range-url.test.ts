import assert from "node:assert/strict";
import test from "node:test";
import { parseAbsoluteRange } from "./range-url.ts";

test("parseAbsoluteRange accepts a valid absolute ISO window", () => {
  assert.deepEqual(parseAbsoluteRange("2026-06-26T02:40:00Z", "2026-06-26T03:10:00Z"), {
    since: "2026-06-26T02:40:00Z",
    until: "2026-06-26T03:10:00Z",
  });
});

test("parseAbsoluteRange rejects a missing bound", () => {
  assert.equal(parseAbsoluteRange(null, "2026-06-26T03:10:00Z"), null);
  assert.equal(parseAbsoluteRange("2026-06-26T02:40:00Z", null), null);
  assert.equal(parseAbsoluteRange(null, null), null);
});

test("parseAbsoluteRange rejects non-ISO / ClickHouse expressions", () => {
  assert.equal(parseAbsoluteRange("now() - INTERVAL 2 HOUR", "now()"), null);
  assert.equal(parseAbsoluteRange("yesterday", "today"), null);
  assert.equal(parseAbsoluteRange("", ""), null);
});

test("parseAbsoluteRange rejects a non-positive window (until <= since)", () => {
  assert.equal(parseAbsoluteRange("2026-06-26T03:10:00Z", "2026-06-26T02:40:00Z"), null);
  assert.equal(parseAbsoluteRange("2026-06-26T03:10:00Z", "2026-06-26T03:10:00Z"), null);
});

test("parseAbsoluteRange rejects impossible calendar dates instead of normalizing them", () => {
  // Date.parse would silently roll these forward; a deep link must not pin them.
  assert.equal(parseAbsoluteRange("2026-02-31T00:00:00Z", "2026-06-26T03:10:00Z"), null); // Feb 31
  assert.equal(parseAbsoluteRange("2026-06-31T00:00:00Z", "2026-06-26T03:10:00Z"), null); // Jun 31
  assert.equal(parseAbsoluteRange("2026-13-01T00:00:00Z", "2026-06-26T03:10:00Z"), null); // month 13
  assert.equal(parseAbsoluteRange("2026-00-10T00:00:00Z", "2026-06-26T03:10:00Z"), null); // month 0
  assert.equal(parseAbsoluteRange("2025-02-29T00:00:00Z", "2026-06-26T03:10:00Z"), null); // 2025 not leap
});

test("parseAbsoluteRange rejects out-of-range time components", () => {
  assert.equal(parseAbsoluteRange("2026-06-26T24:00:00Z", "2026-06-27T00:00:00Z"), null); // hour 24
  assert.equal(parseAbsoluteRange("2026-06-26T10:60:00Z", "2026-06-27T00:00:00Z"), null); // minute 60
});

test("parseAbsoluteRange accepts a real leap day and a space separator", () => {
  assert.deepEqual(parseAbsoluteRange("2024-02-29T00:00:00Z", "2024-03-01T00:00:00Z"), {
    since: "2024-02-29T00:00:00Z",
    until: "2024-03-01T00:00:00Z",
  });
  assert.deepEqual(parseAbsoluteRange("2026-06-26 02:40:00", "2026-06-26 03:10:00"), {
    since: "2026-06-26 02:40:00",
    until: "2026-06-26 03:10:00",
  });
});
