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
