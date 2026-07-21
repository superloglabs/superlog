import type { ClickHouseClient } from "@clickhouse/client";
import type { Step } from "@superlog/telemetry-query";

type SignalKind = "traces" | "logs" | "metrics";

type RawSignalSeriesRow = {
  bucket: string;
  signal: SignalKind;
  count: number | string;
};

export type HomeSignalSeriesPoint = {
  bucket: string;
  traces: number;
  logs: number;
  metrics: number;
};

const METRIC_TABLES = [
  "otel_metrics_gauge",
  "otel_metrics_sum",
  "otel_metrics_histogram",
  "otel_metrics_summary",
  "otel_metrics_exp_histogram",
] as const;

export function mergeHomeSignalSeriesRows(rows: RawSignalSeriesRow[]): HomeSignalSeriesPoint[] {
  const points = new Map<string, HomeSignalSeriesPoint>();
  for (const row of rows) {
    const point = points.get(row.bucket) ?? {
      bucket: row.bucket,
      traces: 0,
      logs: 0,
      metrics: 0,
    };
    point[row.signal] += Number(row.count);
    points.set(row.bucket, point);
  }
  return [...points.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
}

export async function getHomeSignalSeries(
  clickhouse: ClickHouseClient,
  projectId: string,
  range: { since: string; until: string },
  step: Step,
): Promise<{ step: string; rows: HomeSignalSeriesPoint[] }> {
  // Traces and logs use the per-minute event rollup. Metrics use the exact-count
  // usage projections, whose materialized project column avoids scanning the
  // ResourceAttributes map. Tables and interval units come from closed allowlists;
  // all request input is bound through ClickHouse parameters.
  const parts = [
    `
      SELECT
        toString(toStartOfInterval(minute, INTERVAL ${step.n} ${step.unit})) AS bucket,
        signal,
        sum(c) AS count
      FROM events_per_minute
      PREWHERE minute >= toStartOfMinute(parseDateTime64BestEffortOrZero({since:String}))
        AND minute <= parseDateTime64BestEffortOrZero({until:String})
      WHERE project_id = {projectId:String}
        AND signal IN ('traces', 'logs')
      GROUP BY bucket, signal
    `,
    ...METRIC_TABLES.map(
      (table) => `
        SELECT
          toString(toStartOfInterval(TimeUnix, INTERVAL ${step.n} ${step.unit})) AS bucket,
          'metrics' AS signal,
          count() AS count
        FROM ${table}
        PREWHERE TimeUnix >= parseDateTime64BestEffortOrZero({since:String})
          AND TimeUnix <= parseDateTime64BestEffortOrZero({until:String})
        WHERE SuperlogProjectId = {projectId:String}
        GROUP BY bucket
      `,
    ),
  ];
  const result = await clickhouse.query({
    query: `
      SELECT bucket, signal, sum(count) AS count
      FROM (${parts.join(" UNION ALL ")})
      GROUP BY bucket, signal
      ORDER BY bucket ASC
      LIMIT 10000
    `,
    query_params: { projectId, since: range.since, until: range.until },
    format: "JSONEachRow",
  });
  const rows = (await result.json()) as RawSignalSeriesRow[];
  return { step: `${step.n} ${step.unit}`, rows: mergeHomeSignalSeriesRows(rows) };
}
