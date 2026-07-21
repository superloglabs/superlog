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

type HomeSignalSchema = {
  eventsRollup: boolean;
  metricTables: ReadonlySet<string>;
  optimizedMetricTables: ReadonlySet<string>;
};

export function clampHomeSignalStep(step: Step): Step {
  return step.unit === "SECOND" ? { n: 1, unit: "MINUTE" } : step;
}

async function inspectHomeSignalSchema(clickhouse: ClickHouseClient): Promise<HomeSignalSchema> {
  try {
    const result = await clickhouse.query({
      query: `
        SELECT table, max(name = 'SuperlogProjectId') AS optimized
        FROM system.columns
        WHERE database = currentDatabase()
          AND table IN (
            'events_per_minute',
            'otel_metrics_gauge',
            'otel_metrics_sum',
            'otel_metrics_histogram',
            'otel_metrics_summary',
            'otel_metrics_exp_histogram'
          )
        GROUP BY table
      `,
      format: "JSONEachRow",
    });
    const rows = (await result.json()) as Array<{
      table: string;
      optimized: number | string;
    }>;
    return {
      eventsRollup: rows.some(({ table }) => table === "events_per_minute"),
      metricTables: new Set(
        rows
          .map(({ table }) => table)
          .filter((table) => METRIC_TABLES.includes(table as (typeof METRIC_TABLES)[number])),
      ),
      optimizedMetricTables: new Set(
        rows.filter(({ optimized }) => Number(optimized) === 1).map(({ table }) => table),
      ),
    };
  } catch {
    return { eventsRollup: false, metricTables: new Set(), optimizedMetricTables: new Set() };
  }
}

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
  const schema = await inspectHomeSignalSchema(clickhouse);
  const safeStep = clampHomeSignalStep(step);
  // Traces and logs use the per-minute event rollup. Metrics use the exact-count
  // usage projections, whose materialized project column avoids scanning the
  // ResourceAttributes map. Older/self-hosted schemas retain a raw-table fallback.
  // Tables and interval units come from closed allowlists; all request input is
  // bound through ClickHouse parameters.
  const eventParts = schema.eventsRollup
    ? [
        `
      SELECT
        toString(toStartOfInterval(minute, INTERVAL ${safeStep.n} ${safeStep.unit})) AS bucket,
        signal,
        sum(c) AS count
      FROM events_per_minute
      PREWHERE minute >= toStartOfMinute(parseDateTime64BestEffortOrZero({since:String}))
        AND minute <= parseDateTime64BestEffortOrZero({until:String})
      WHERE project_id = {projectId:String}
        AND signal IN ('traces', 'logs')
      GROUP BY bucket, signal
    `,
      ]
    : [
        `
          SELECT
            toString(toStartOfInterval(Timestamp, INTERVAL ${safeStep.n} ${safeStep.unit})) AS bucket,
            'traces' AS signal,
            count() AS count
          FROM otel_traces
          WHERE ResourceAttributes['superlog.project_id'] = {projectId:String}
            AND Timestamp >= parseDateTime64BestEffortOrZero({since:String})
            AND Timestamp <= parseDateTime64BestEffortOrZero({until:String})
          GROUP BY bucket
        `,
        `
          SELECT
            toString(toStartOfInterval(TimestampTime, INTERVAL ${safeStep.n} ${safeStep.unit})) AS bucket,
            'logs' AS signal,
            count() AS count
          FROM otel_logs
          WHERE ResourceAttributes['superlog.project_id'] = {projectId:String}
            AND TimestampTime >= parseDateTime64BestEffortOrZero({since:String})
            AND TimestampTime <= parseDateTime64BestEffortOrZero({until:String})
          GROUP BY bucket
        `,
      ];
  const metricParts = METRIC_TABLES.filter((table) => schema.metricTables.has(table)).map(
    (table) => {
      const projectId = schema.optimizedMetricTables.has(table)
        ? "SuperlogProjectId"
        : "ResourceAttributes['superlog.project_id']";
      return `
      SELECT
        toString(toStartOfInterval(TimeUnix, INTERVAL ${safeStep.n} ${safeStep.unit})) AS bucket,
        'metrics' AS signal,
        count() AS count
      FROM ${table}
      PREWHERE TimeUnix >= parseDateTime64BestEffortOrZero({since:String})
        AND TimeUnix <= parseDateTime64BestEffortOrZero({until:String})
      WHERE ${projectId} = {projectId:String}
      GROUP BY bucket
    `;
    },
  );
  const parts = [...eventParts, ...metricParts];
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
  return {
    step: `${safeStep.n} ${safeStep.unit}`,
    rows: mergeHomeSignalSeriesRows(rows),
  };
}
