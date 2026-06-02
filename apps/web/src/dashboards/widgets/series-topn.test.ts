import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_TOP_N, OTHER_LABEL, buildTopNSeries } from "./series-topn.ts";

const count = (r: { count: number }) => r.count;

function rowsFor(groups: { group: string; count: number }[], buckets: string[]) {
  return groups.flatMap((g) => buckets.map((b) => ({ bucket: b, group: g.group, count: g.count })));
}

test("returns empty for no rows", () => {
  assert.deepEqual(buildTopNSeries([], count, 10), []);
});

test("orders series by total descending", () => {
  const rows = [
    { bucket: "2026-06-01 00:00:00", group: "a", count: 1 },
    { bucket: "2026-06-01 00:00:00", group: "b", count: 5 },
    { bucket: "2026-06-01 00:00:00", group: "c", count: 3 },
  ];
  const series = buildTopNSeries(rows, count, 10);
  assert.deepEqual(
    series.map((s) => s.name),
    ["b", "c", "a"],
  );
  assert.deepEqual(
    series.map((s) => s.total),
    [5, 3, 1],
  );
});

test("rolls groups beyond the limit into a single Other series, placed last", () => {
  // 5 groups, limit 3 → top 3 + Other (sum of remaining 2).
  const rows = rowsFor(
    [
      { group: "g1", count: 100 },
      { group: "g2", count: 50 },
      { group: "g3", count: 25 },
      { group: "g4", count: 10 },
      { group: "g5", count: 4 },
    ],
    ["2026-06-01 00:00:00", "2026-06-01 00:01:00"],
  );
  const series = buildTopNSeries(rows, count, 3);
  assert.deepEqual(
    series.map((s) => s.name),
    ["g1", "g2", "g3", OTHER_LABEL],
  );
  const other = series.at(-1);
  assert.ok(other);
  assert.equal(other.isOther, true);
  // Other = (g4 + g5) summed across both buckets = (10+4)*2 = 28.
  assert.equal(other.total, 28);
  // Per-bucket: each bucket holds g4+g5 = 14.
  assert.deepEqual(
    other.data.map((d) => d[1]),
    [14, 14],
  );
});

test("no Other series when group count is at or below the limit", () => {
  const rows = rowsFor(
    [
      { group: "a", count: 2 },
      { group: "b", count: 1 },
    ],
    ["2026-06-01 00:00:00"],
  );
  const series = buildTopNSeries(rows, count, 10);
  assert.equal(series.length, 2);
  assert.equal(
    series.some((s) => s.isOther),
    false,
  );
});

test("zero-fills missing buckets so every series shares the time axis", () => {
  const rows = [
    { bucket: "2026-06-01 00:00:00", group: "a", count: 3 },
    { bucket: "2026-06-01 00:01:00", group: "b", count: 7 }, // a missing here
  ];
  const series = buildTopNSeries(rows, count, 10);
  const a = series.find((s) => s.name === "a");
  assert.ok(a);
  assert.equal(a.data.length, 2);
  assert.deepEqual(
    a.data.map((d) => d[1]),
    [3, 0],
  );
  // timestamps ascending, parsed as UTC ms
  const first = a.data[0];
  const second = a.data[1];
  assert.ok(first);
  assert.ok(second);
  assert.ok(first[0] < second[0]);
  assert.equal(first[0], Date.parse("2026-06-01T00:00:00Z"));
});

test("empty group label becomes (none)", () => {
  const rows = [{ bucket: "2026-06-01 00:00:00", group: "", count: 1 }];
  const series = buildTopNSeries(rows, count, 10);
  assert.equal(series[0]?.name, "(none)");
});

test("limit < 1 means no rollup", () => {
  const rows = rowsFor(
    Array.from({ length: 15 }, (_, i) => ({ group: `g${i}`, count: 15 - i })),
    ["2026-06-01 00:00:00"],
  );
  const series = buildTopNSeries(rows, count, 0);
  assert.equal(series.length, 15);
  assert.equal(
    series.some((s) => s.isOther),
    false,
  );
});

test("default top-N is 10", () => {
  const rows = rowsFor(
    Array.from({ length: 14 }, (_, i) => ({ group: `g${i}`, count: 14 - i })),
    ["2026-06-01 00:00:00"],
  );
  const series = buildTopNSeries(rows, count);
  assert.equal(series.length, DEFAULT_TOP_N + 1); // 10 + Other
  assert.equal(series.at(-1)?.name, OTHER_LABEL);
});
