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

const SIGNAL_TABLES = [
  { table: "otel_traces", timestamp: "Timestamp", signal: "traces" },
  { table: "otel_logs", timestamp: "TimestampTime", signal: "logs" },
  { table: "otel_metrics_gauge", timestamp: "TimeUnix", signal: "metrics" },
  { table: "otel_metrics_sum", timestamp: "TimeUnix", signal: "metrics" },
  { table: "otel_metrics_histogram", timestamp: "TimeUnix", signal: "metrics" },
  { table: "otel_metrics_summary", timestamp: "TimeUnix", signal: "metrics" },
  { table: "otel_metrics_exp_histogram", timestamp: "TimeUnix", signal: "metrics" },
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
  // Tables, timestamp columns, signal names, and interval units are all selected
  // from closed allowlists above / in telemetry-query's pickStep(). User input is
  // bound through ClickHouse parameters.
  const parts = SIGNAL_TABLES.map(
    ({ table, timestamp, signal }) => `
      SELECT
        toString(toStartOfInterval(${timestamp}, INTERVAL ${step.n} ${step.unit})) AS bucket,
        '${signal}' AS signal,
        count() AS count
      FROM ${table}
      WHERE ResourceAttributes['superlog.project_id'] = {projectId:String}
        AND ${timestamp} >= parseDateTime64BestEffortOrZero({since:String})
        AND ${timestamp} <= parseDateTime64BestEffortOrZero({until:String})
      GROUP BY bucket
    `,
  );
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
