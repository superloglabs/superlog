import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_TOP_N, OTHER_LABEL, buildTopNSeries, parseStepMs } from "./series-topn.ts";

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

test("a real group named Other does not collide with the rollup remainder", () => {
  // 'Other' is itself a top group here; g2/g3 fall beyond the cut and roll up.
  const rows = rowsFor(
    [
      { group: "Other", count: 100 },
      { group: "g1", count: 50 },
      { group: "g2", count: 10 },
      { group: "g3", count: 5 },
    ],
    ["2026-06-01 00:00:00", "2026-06-01 00:01:00"],
  );
  const series = buildTopNSeries(rows, count, 2);

  // The real "Other" group keeps its own (un-merged) data.
  const real = series.find((s) => s.name === "Other" && !s.isOther);
  assert.ok(real, "real 'Other' group is preserved");
  assert.equal(real.total, 200); // 100 across 2 buckets

  // The synthetic rollup is a distinct series with a distinct legend label.
  const rollup = series.find((s) => s.isOther);
  assert.ok(rollup, "rollup series present");
  assert.equal(rollup.total, 30); // (10 + 5) across 2 buckets
  assert.notEqual(rollup.name, real.name);

  // Exactly one rollup and exactly one series literally named "Other".
  assert.equal(series.filter((s) => s.isOther).length, 1);
  assert.equal(series.filter((s) => s.name === "Other").length, 1);
});

test("rollup name stays unique even when 'Other' and 'Other (rest)' are real groups", () => {
  const rows = rowsFor(
    [
      { group: "Other", count: 100 },
      { group: "Other (rest)", count: 90 },
      { group: "g1", count: 10 },
      { group: "g2", count: 5 },
    ],
    ["2026-06-01 00:00:00"],
  );
  const series = buildTopNSeries(rows, count, 2);
  const rollup = series.find((s) => s.isOther);
  assert.ok(rollup);
  // Distinct from both real group names that would otherwise collide.
  const realNames = series.filter((s) => !s.isOther).map((s) => s.name);
  assert.equal(realNames.includes(rollup.name), false);
  // All output names are unique (visibility/legend/tooltip are name-keyed).
  assert.equal(new Set(series.map((s) => s.name)).size, series.length);
});

test("works with an arbitrary value accessor (metric series use r.value)", () => {
  const rows = [
    { bucket: "2026-06-01 00:00:00", group: "p99", value: 12.5 },
    { bucket: "2026-06-01 00:00:00", group: "p50", value: 3.2 },
  ];
  const series = buildTopNSeries(rows, (r) => r.value, 10);
  assert.deepEqual(
    series.map((s) => s.name),
    ["p99", "p50"],
  );
  assert.equal(series[0]?.total, 12.5);
});

test("parseStepMs parses the API step string", () => {
  assert.equal(parseStepMs("30 SECOND"), 30_000);
  assert.equal(parseStepMs("5 MINUTE"), 300_000);
  assert.equal(parseStepMs("3 HOUR"), 10_800_000);
  assert.equal(parseStepMs("1 DAY"), 86_400_000);
  assert.equal(parseStepMs("garbage"), null);
  assert.equal(parseStepMs(undefined), null);
});

test("grid fill expands the bucket axis across the whole window with zeros", () => {
  // Data only in the last two of six 1-minute buckets.
  const rows = [
    { bucket: "2026-06-01 00:04:00", group: "a", count: 3 },
    { bucket: "2026-06-01 00:05:00", group: "a", count: 7 },
  ];
  const grid = {
    sinceMs: Date.parse("2026-06-01T00:00:00Z"),
    untilMs: Date.parse("2026-06-01T00:05:00Z"),
    stepMs: 60_000,
  };
  const series = buildTopNSeries(rows, count, 10, grid);
  const a = series.find((s) => s.name === "a");
  assert.ok(a);
  // 00:00 through 00:05 inclusive = 6 buckets, zeros where no data.
  assert.equal(a.data.length, 6);
  assert.deepEqual(
    a.data.map((d) => d[1]),
    [0, 0, 0, 0, 3, 7],
  );
  assert.equal(a.data[0]?.[0], Date.parse("2026-06-01T00:00:00Z"));
  // Totals come from real data only.
  assert.equal(a.total, 10);
});

test("grid fill aligns its start to the step and keeps off-grid data buckets", () => {
  const rows = [{ bucket: "2026-06-01 00:02:30", group: "a", count: 1 }];
  const grid = {
    sinceMs: Date.parse("2026-06-01T00:00:30Z"), // mid-bucket window start
    untilMs: Date.parse("2026-06-01T00:03:00Z"),
    stepMs: 60_000,
  };
  const series = buildTopNSeries(rows, count, 10, grid);
  const a = series.find((s) => s.name === "a");
  assert.ok(a);
  // Grid points 00:00..00:03 (floor-aligned) plus the off-grid 00:02:30 bucket.
  assert.equal(a.data[0]?.[0], Date.parse("2026-06-01T00:00:00Z"));
  assert.ok(a.data.some((d) => d[0] === Date.parse("2026-06-01T00:02:30Z") && d[1] === 1));
});

test("grid fill is skipped when it would explode the bucket count", () => {
  const rows = [{ bucket: "2026-06-01 00:00:00", group: "a", count: 1 }];
  const grid = {
    sinceMs: Date.parse("2026-01-01T00:00:00Z"),
    untilMs: Date.parse("2026-06-01T00:00:00Z"),
    stepMs: 1_000, // ~13M buckets — defensive cap kicks in
  };
  const series = buildTopNSeries(rows, count, 10, grid);
  assert.equal(series[0]?.data.length, 1);
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
