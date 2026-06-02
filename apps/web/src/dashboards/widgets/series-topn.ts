// Pure transform: collapse a flat list of grouped series rows into the top-N
// series by total, rolling everything beyond the cut into a single "Other"
// series. Output is shaped for an [ms, value][] time-series chart (Kumo /
// ECharts), but the logic is chart-library agnostic so it can back the recharts
// path too.
//
// Kept dependency-free (no react/api imports) so it runs under `tsx --test`.

export const OTHER_LABEL = "Other";
const NONE_LABEL = "(none)";

export const DEFAULT_TOP_N = 10;

export type GroupedRow = { bucket: string; group: string };

export type ChartSeries = {
  /** Group value, or "Other" for the rolled-up remainder, "(none)" when empty. */
  name: string;
  /** Sum of every point in this series — drives ordering and the legend value. */
  total: number;
  /** `[timestamp_ms, value]` tuples, one per bucket, ascending by time. */
  data: [number, number][];
  /** True only for the synthetic rolled-up remainder series. */
  isOther: boolean;
};

// bucket is ClickHouse "YYYY-MM-DD HH:MM:SS" in UTC (see timeFormat.ts).
function bucketToMs(bucket: string): number {
  return new Date(`${bucket.replace(" ", "T")}Z`).getTime();
}

/**
 * Build at most `limit` real series (highest total first) plus, if more groups
 * exist, a single "Other" series summing the remainder per bucket.
 *
 * @param limit  max real series before rollup; values < 1 mean "no limit".
 */
export function buildTopNSeries<T extends GroupedRow>(
  rows: T[],
  valFn: (r: T) => number,
  limit: number = DEFAULT_TOP_N,
): ChartSeries[] {
  if (rows.length === 0) return [];

  // Stable, sorted bucket axis shared by every series so points align.
  const bucketSet = new Set<string>();
  const totals = new Map<string, number>();
  for (const r of rows) {
    bucketSet.add(r.bucket);
    const g = r.group || NONE_LABEL;
    totals.set(g, (totals.get(g) ?? 0) + valFn(r));
  }
  const buckets = [...bucketSet].sort();
  const bucketIndex = new Map(buckets.map((b, i) => [b, i]));

  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g);
  const cut = limit >= 1 ? limit : ranked.length;
  const topGroups = new Set(ranked.slice(0, cut));
  const hasOther = ranked.length > topGroups.size;

  // Accumulate per-bucket values, zero-filled, so lines/bars don't gap.
  const points = new Map<string, number[]>();
  for (const g of topGroups) points.set(g, new Array(buckets.length).fill(0));
  if (hasOther) points.set(OTHER_LABEL, new Array(buckets.length).fill(0));

  for (const r of rows) {
    const g = r.group || NONE_LABEL;
    const key = topGroups.has(g) ? g : OTHER_LABEL;
    const arr = points.get(key);
    const i = bucketIndex.get(r.bucket);
    if (!arr || i === undefined) continue;
    arr[i] = (arr[i] ?? 0) + valFn(r);
  }

  const toSeries = (name: string, isOther: boolean): ChartSeries => {
    const arr = points.get(name) ?? [];
    let total = 0;
    const data: [number, number][] = buckets.map((b, i) => {
      const v = arr[i] ?? 0;
      total += v;
      return [bucketToMs(b), v];
    });
    return { name, total, data, isOther };
  };

  // Real series in rank order, "Other" always last.
  const series = ranked.filter((g) => topGroups.has(g)).map((g) => toSeries(g, false));
  if (hasOther) series.push(toSeries(OTHER_LABEL, true));
  return series;
}
