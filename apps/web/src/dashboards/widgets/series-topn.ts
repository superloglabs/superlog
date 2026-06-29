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

/**
 * Time grid for bar charts: every `stepMs` bucket across [sinceMs, untilMs]
 * exists on the axis (zero-filled), so bar band width is always one server
 * bucket and empty stretches render as empty space instead of bars stretching
 * to fill the data extent.
 */
export type BucketGrid = { sinceMs: number; untilMs: number; stepMs: number };

// Defensive cap: the server targets ~120 buckets per window (pickStep), so a
// grid bigger than this means mismatched inputs — better to skip the fill
// than to allocate millions of points.
const MAX_GRID_POINTS = 2000;

const STEP_UNIT_MS: Record<string, number> = {
  SECOND: 1_000,
  MINUTE: 60_000,
  HOUR: 3_600_000,
  DAY: 86_400_000,
};

/** Parse the API's step string ("5 MINUTE") into milliseconds. */
export function parseStepMs(step: string | undefined): number | null {
  if (!step) return null;
  const m = /^(\d+)\s+(SECOND|MINUTE|HOUR|DAY)$/.exec(step.trim());
  if (!m) return null;
  const unit = STEP_UNIT_MS[m[2] ?? ""];
  if (!unit) return null;
  const ms = Number(m[1]) * unit;
  return ms > 0 ? ms : null;
}

// All step-ladder intervals divide evenly into their parent unit, so flooring
// to the step in epoch ms matches ClickHouse's toStartOfInterval (UTC).
function gridBucketsMs(grid: BucketGrid): number[] | null {
  const { sinceMs, untilMs, stepMs } = grid;
  if (!(stepMs > 0) || !(untilMs >= sinceMs)) return null;
  if ((untilMs - sinceMs) / stepMs > MAX_GRID_POINTS) return null;
  const out: number[] = [];
  for (let t = Math.floor(sinceMs / stepMs) * stepMs; t <= untilMs; t += stepMs) out.push(t);
  return out;
}

export type ChartSeries = {
  /** Group value, or "Other" for the rolled-up remainder, "(none)" when empty. */
  name: string;
  /** Sum of every point in this series — drives top-N ordering. */
  total: number;
  /** `[timestamp_ms, value]` tuples, one per bucket, ascending by time. */
  data: [number, number][];
  /**
   * Per-bucket values for buckets this series actually has data in — the
   * cross-series zero-fill in `data` is excluded. Drives the legend headline so
   * summaries like avg/min reflect the real distribution, not padded zeros.
   */
  values: number[];
  /** True only for the synthetic rolled-up remainder series. */
  isOther: boolean;
};

// Pick a rollup label that doesn't clash with any real group name, so the
// synthetic series stays distinguishable everywhere series are keyed by name.
function uniqueOtherName(taken: Set<string>): string {
  if (!taken.has(OTHER_LABEL)) return OTHER_LABEL;
  let name = `${OTHER_LABEL} (rest)`;
  for (let i = 2; taken.has(name); i++) name = `${OTHER_LABEL} (rest ${i})`;
  return name;
}

// bucket is ClickHouse "YYYY-MM-DD HH:MM:SS" in UTC (see timeFormat.ts).
function bucketToMs(bucket: string): number {
  return new Date(`${bucket.replace(" ", "T")}Z`).getTime();
}

/**
 * Build at most `limit` real series (highest total first) plus, if more groups
 * exist, a single "Other" series summing the remainder per bucket.
 *
 * @param limit  max real series before rollup; values < 1 mean "no limit".
 * @param grid   optional full-window bucket grid to zero-fill (bar charts).
 */
export function buildTopNSeries<T extends GroupedRow>(
  rows: T[],
  valFn: (r: T) => number,
  limit: number = DEFAULT_TOP_N,
  grid?: BucketGrid,
): ChartSeries[] {
  if (rows.length === 0) return [];

  // Stable, sorted bucket axis (epoch ms) shared by every series so points
  // align; the optional grid extends it across the whole query window.
  const bucketSet = new Set<number>();
  const totals = new Map<string, number>();
  for (const r of rows) {
    bucketSet.add(bucketToMs(r.bucket));
    const g = r.group || NONE_LABEL;
    totals.set(g, (totals.get(g) ?? 0) + valFn(r));
  }
  if (grid) for (const t of gridBucketsMs(grid) ?? []) bucketSet.add(t);
  const buckets = [...bucketSet].sort((a, b) => a - b);
  const bucketIndex = new Map(buckets.map((b, i) => [b, i]));

  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g);
  const cut = limit >= 1 ? limit : ranked.length;
  const topGroups = new Set(ranked.slice(0, cut));
  const hasOther = ranked.length > topGroups.size;

  // Accumulate per-bucket values, zero-filled, so lines/bars don't gap. The
  // rollup remainder lives in its own accumulator (not the points map) so a
  // real group literally named "Other" can't collide with the synthetic series.
  // `seen` tracks which buckets each series actually has a row in, so the chart
  // can zero-fill `data` for alignment while the legend summary (`values`) skips
  // those padded buckets.
  const points = new Map<string, number[]>();
  const seen = new Map<string, boolean[]>();
  for (const g of topGroups) {
    points.set(g, new Array(buckets.length).fill(0));
    seen.set(g, new Array(buckets.length).fill(false));
  }
  const otherArr = hasOther ? new Array<number>(buckets.length).fill(0) : null;
  const otherSeen = hasOther ? new Array<boolean>(buckets.length).fill(false) : null;

  for (const r of rows) {
    const g = r.group || NONE_LABEL;
    const inTop = topGroups.has(g);
    const arr = inTop ? points.get(g) : otherArr;
    const seenArr = inTop ? seen.get(g) : otherSeen;
    const i = bucketIndex.get(bucketToMs(r.bucket));
    if (!arr || !seenArr || i === undefined) continue;
    arr[i] = (arr[i] ?? 0) + valFn(r);
    seenArr[i] = true;
  }

  const toSeries = (
    name: string,
    arr: number[],
    seenArr: boolean[],
    isOther: boolean,
  ): ChartSeries => {
    let total = 0;
    const values: number[] = [];
    const data: [number, number][] = buckets.map((b, i) => {
      const v = arr[i] ?? 0;
      total += v;
      if (seenArr[i]) values.push(v);
      return [b, v];
    });
    return { name, total, data, values, isOther };
  };

  // Real series in rank order, "Other" always last.
  const series = ranked
    .filter((g) => topGroups.has(g))
    .map((g) => toSeries(g, points.get(g) ?? [], seen.get(g) ?? [], false));
  if (otherArr && otherSeen) {
    // The rollup name must be unique among the real series — visibility,
    // legend, and tooltip dedup are all keyed by name (see CountChart).
    series.push(toSeries(uniqueOtherName(topGroups), otherArr, otherSeen, true));
  }
  return series;
}
