import assert from "node:assert/strict";
import test from "node:test";
import { formatValue, summarizeSeries } from "./widget-format.ts";

test("summarizeSeries: sum/avg/min/max", () => {
  const v = [2, 4, 6];
  assert.equal(summarizeSeries(v, "sum"), 12);
  assert.equal(summarizeSeries(v, "avg"), 4);
  assert.equal(summarizeSeries(v, "min"), 2);
  assert.equal(summarizeSeries(v, "max"), 6);
});

test("summarizeSeries: empty series is 0", () => {
  assert.equal(summarizeSeries([], "avg"), 0);
  assert.equal(summarizeSeries([], "sum"), 0);
});

test("summarizeSeries: percentiles use nearest-rank", () => {
  const v = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
  assert.equal(summarizeSeries(v, "p95"), 95);
  assert.equal(summarizeSeries(v, "p99"), 99);
});

test("summarizeSeries: avg ignores absent buckets (no zero pollution)", () => {
  // The caller passes only present buckets, so a sparse series averages to its
  // real mean rather than being dragged toward zero.
  assert.equal(summarizeSeries([15000, 15000], "avg"), 15000);
  assert.equal(summarizeSeries([15000, 15000], "min"), 15000);
});

test("formatValue none: integers exact, decimals up to 3 places", () => {
  assert.equal(formatValue(42, "none"), "42");
  assert.equal(formatValue(1.23456, "none"), "1.235");
});

test("formatValue none: compact notation for huge magnitudes", () => {
  // The legend SUM that motivated this: 1,922,160 -> short, not a wall of digits.
  assert.equal(formatValue(1_922_160, "none"), "1.9M");
  assert.equal(formatValue(1_852_782.5, "none"), "1.9M");
  // Y-axis ticks like 60000 stay exact (below the compact threshold).
  assert.equal(formatValue(60000, "none"), "60,000");
});

test("formatValue duration_ms auto-scales ms to a human unit", () => {
  assert.equal(formatValue(250, "duration_ms"), "250ms");
  assert.equal(formatValue(15000, "duration_ms"), "15s");
  assert.equal(formatValue(1900, "duration_ms"), "1.9s");
  assert.equal(formatValue(90000, "duration_ms"), "1.5min");
  assert.equal(formatValue(7_200_000, "duration_ms"), "2h");
});

test("formatValue duration_s treats the value as seconds", () => {
  assert.equal(formatValue(15, "duration_s"), "15s");
  assert.equal(formatValue(0.25, "duration_s"), "250ms");
});

test("formatValue bytes uses base-1024 units", () => {
  assert.equal(formatValue(512, "bytes"), "512B");
  assert.equal(formatValue(1024, "bytes"), "1KB");
  assert.equal(formatValue(1_572_864, "bytes"), "1.5MB");
});

test("formatValue percent appends a percent sign", () => {
  assert.equal(formatValue(42.5, "percent"), "42.5%");
  assert.equal(formatValue(100, "percent"), "100%");
});

test("formatValue is safe for non-finite input", () => {
  assert.equal(formatValue(Number.NaN, "none"), "—");
  assert.equal(formatValue(Number.POSITIVE_INFINITY, "duration_ms"), "—");
});
