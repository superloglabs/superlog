import assert from "node:assert/strict";
import { test } from "node:test";
import { currentBillingPeriod, periodKey } from "./period.js";

function iso(d: Date): string {
  return d.toISOString();
}

test("calendar-month period (anchor day 1)", () => {
  const p = currentBillingPeriod(new Date("2026-05-15T12:00:00Z"), 1);
  assert.equal(iso(p.start), "2026-05-01T00:00:00.000Z");
  assert.equal(iso(p.end), "2026-06-01T00:00:00.000Z");
});

test("anchored period: now after the anchor day starts this month", () => {
  const p = currentBillingPeriod(new Date("2026-05-15T12:00:00Z"), 10);
  assert.equal(iso(p.start), "2026-05-10T00:00:00.000Z");
  assert.equal(iso(p.end), "2026-06-10T00:00:00.000Z");
});

test("anchored period: now before the anchor day rolls back to last month", () => {
  const p = currentBillingPeriod(new Date("2026-05-05T12:00:00Z"), 10);
  assert.equal(iso(p.start), "2026-04-10T00:00:00.000Z");
  assert.equal(iso(p.end), "2026-05-10T00:00:00.000Z");
});

test("now exactly on the anchor at midnight is inside the new period", () => {
  const p = currentBillingPeriod(new Date("2026-05-10T00:00:00Z"), 10);
  assert.equal(iso(p.start), "2026-05-10T00:00:00.000Z");
});

test("year boundary rolls back correctly", () => {
  const p = currentBillingPeriod(new Date("2026-01-05T00:00:00Z"), 10);
  assert.equal(iso(p.start), "2025-12-10T00:00:00.000Z");
  assert.equal(iso(p.end), "2026-01-10T00:00:00.000Z");
});

test("anchor day past 28 is clamped to 28 to dodge short months", () => {
  const p = currentBillingPeriod(new Date("2026-03-15T00:00:00Z"), 31);
  assert.equal(iso(p.start), "2026-02-28T00:00:00.000Z");
  assert.equal(iso(p.end), "2026-03-28T00:00:00.000Z");
});

test("periodKey is the UTC date of the period start", () => {
  const p = currentBillingPeriod(new Date("2026-05-15T12:00:00Z"), 10);
  assert.equal(periodKey(p), "2026-05-10");
});
