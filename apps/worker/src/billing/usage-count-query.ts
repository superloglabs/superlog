import type { UsageSignal } from "./usage-metering.js";

// One bounded-window count query per signal. Metrics span five OTel tables.
export function buildUsageCountQuery(signal: UsageSignal): string {
  if (signal === "spans") {
    return `SELECT ResourceAttributes['superlog.project_id'] AS pid, count() AS c
            FROM otel_traces
            WHERE Timestamp > {after:DateTime64(9)} AND Timestamp <= {until:DateTime64(9)} AND pid != ''
            GROUP BY pid`;
  }
  if (signal === "logs") {
    return `SELECT ResourceAttributes['superlog.project_id'] AS pid, count() AS c
            FROM otel_logs
            WHERE Timestamp > {after:DateTime64(9)} AND Timestamp <= {until:DateTime64(9)}
              AND TimestampTime >= {after:DateTime64(9)} - INTERVAL 1 SECOND
              AND TimestampTime <= {until:DateTime64(9)}
              AND pid != ''
            GROUP BY pid`;
  }
  const metricTables = [
    "otel_metrics_sum",
    "otel_metrics_gauge",
    "otel_metrics_histogram",
    "otel_metrics_summary",
    "otel_metrics_exp_histogram",
  ];
  const union = metricTables
    .map(
      (t) =>
        `SELECT ResourceAttributes['superlog.project_id'] AS pid, count() AS c FROM ${t}
         WHERE TimeUnix > {after:DateTime64(9)} AND TimeUnix <= {until:DateTime64(9)} AND pid != '' GROUP BY pid`,
    )
    .join(" UNION ALL ");
  return `SELECT pid, sum(c) AS c FROM (${union}) GROUP BY pid`;
}
