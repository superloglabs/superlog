import { METRIC_TABLES, METRIC_USAGE_PROJECT_ID_COLUMN } from "./metric-usage-schema.js";
import type { UsageSignal } from "./usage-metering.js";

export { METRIC_TABLES } from "./metric-usage-schema.js";

const RESOURCE_PROJECT_ID = "ResourceAttributes['superlog.project_id']";
const NO_OPTIMIZED_METRIC_TABLES: ReadonlySet<string> = new Set();

function metricCountQuery(table: string, optimizedTables: ReadonlySet<string>): string {
  const projectId = optimizedTables.has(table)
    ? METRIC_USAGE_PROJECT_ID_COLUMN
    : RESOURCE_PROJECT_ID;
  return `SELECT ${projectId} AS pid, count() AS c FROM ${table}
          PREWHERE TimeUnix > {after:DateTime64(9)} AND TimeUnix <= {until:DateTime64(9)}
          WHERE ${projectId} != '' GROUP BY pid`;
}

export function buildUsageCountQueries(
  signal: UsageSignal,
  optimizedMetricTables: ReadonlySet<string> = NO_OPTIMIZED_METRIC_TABLES,
): string[] {
  if (signal === "metric_points") {
    return METRIC_TABLES.map((table) => metricCountQuery(table, optimizedMetricTables));
  }
  return [buildUsageCountQuery(signal)];
}

// One bounded-window count query per signal. Metrics span five OTel tables.
export function buildUsageCountQuery(signal: Exclude<UsageSignal, "metric_points">): string {
  if (signal === "spans") {
    return `SELECT ResourceAttributes['superlog.project_id'] AS pid, count() AS c
            FROM otel_traces
            WHERE Timestamp > {after:DateTime64(9)} AND Timestamp <= {until:DateTime64(9)} AND pid != ''
            GROUP BY pid`;
  }
  return `SELECT ResourceAttributes['superlog.project_id'] AS pid, count() AS c
          FROM otel_logs
          WHERE Timestamp > {after:DateTime64(9)} AND Timestamp <= {until:DateTime64(9)}
            AND TimestampTime >= {after:DateTime64(9)} - INTERVAL 1 SECOND
            AND TimestampTime <= {until:DateTime64(9)}
            AND pid != ''
          GROUP BY pid`;
}
