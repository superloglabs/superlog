import type { ClickHouseClient } from "@clickhouse/client";
import type { schema } from "@superlog/db";
import type { EvaluationRange } from "./domain.js";

export type AlertMetricsRepository = ReturnType<typeof createAlertMetricsRepository>;

// All entries return a server-side *sum* of the per-point values, and the
// JS-side aggregation in aggregateMetric divides by count() for `avg`. If a
// row returned a server-side average (e.g. avg(Value)), the JS code would
// compute avg / count() = totalSum / N² — incorrect. Keep this consistent.
const METRIC_SERIES_TABLES: { table: string; valueExpr: string }[] = [
  { table: "otel_metrics_gauge", valueExpr: "sum(Value)" },
  { table: "otel_metrics_sum", valueExpr: "sum(Value)" },
  { table: "otel_metrics_histogram", valueExpr: "sum(Sum)" },
  { table: "otel_metrics_summary", valueExpr: "sum(Sum)" },
  { table: "otel_metrics_exp_histogram", valueExpr: "sum(Sum)" },
];

function attrConds(attrs: { key: string; value: string }[] | undefined): {
  conds: string[];
  params: Record<string, string>;
} {
  const conds: string[] = [];
  const params: Record<string, string> = {};
  if (!attrs) return { conds, params };
  attrs.forEach((a, i) => {
    const k = `aalert_k_${i}`;
    const v = `aalert_v_${i}`;
    conds.push(`ResourceAttributes[{${k}:String}] = {${v}:String}`);
    params[k] = a.key;
    params[v] = a.value;
  });
  return { conds, params };
}

function groupExprFor(groupBy: string | null | undefined): {
  expr: string;
  params: Record<string, string>;
} {
  if (!groupBy) return { expr: "''", params: {} };
  if (groupBy === "service.name" || groupBy === "service") {
    return { expr: "ServiceName", params: {} };
  }
  return {
    expr: "ResourceAttributes[{aalert_groupKey:String}]",
    params: { aalert_groupKey: groupBy },
  };
}

function isMissingTableError(err: unknown): boolean {
  return (
    err instanceof Error &&
    /UNKNOWN_TABLE|UNKNOWN_IDENTIFIER|doesn't exist/i.test(err.message)
  );
}

export function createAlertMetricsRepository(ch: ClickHouseClient) {
  async function aggregateCount(
    alert: schema.Alert,
    range: EvaluationRange,
  ): Promise<Map<string, number>> {
    const table = alert.source === "logs" ? "otel_logs" : "otel_traces";
    const attr = attrConds(alert.filter.resourceAttrs);
    const group = groupExprFor(alert.groupBy);
    const conds: string[] = [
      "ResourceAttributes['superlog.project_id'] = {projectId:String}",
      "Timestamp >= parseDateTime64BestEffortOrZero({since:String})",
      "Timestamp <= parseDateTime64BestEffortOrZero({until:String})",
      ...attr.conds,
    ];
    if (alert.filter.service) conds.push("ServiceName = {service:String}");
    if (alert.source === "logs") {
      if (alert.filter.severity) conds.push("upper(SeverityText) = upper({severity:String})");
    } else {
      if (alert.filter.spanName) conds.push("SpanName = {spanName:String}");
      if (alert.filter.statusCode) conds.push("StatusCode = {statusCode:String}");
      if (typeof alert.filter.minDurationMs === "number") {
        conds.push("Duration >= {minDurationNs:UInt64}");
      }
    }
    const r = await ch.query({
      query: `
        SELECT ${group.expr} AS group_key, count() AS v
        FROM ${table}
        WHERE ${conds.join(" AND ")}
        GROUP BY group_key
        LIMIT 1000
      `,
      query_params: {
        projectId: alert.projectId,
        since: range.since,
        until: range.until,
        service: alert.filter.service ?? "",
        severity: alert.filter.severity ?? "",
        spanName: alert.filter.spanName ?? "",
        statusCode: alert.filter.statusCode ?? "",
        minDurationNs: Math.round((alert.filter.minDurationMs ?? 0) * 1_000_000),
        ...attr.params,
        ...group.params,
      },
      format: "JSONEachRow",
    });
    const rows = (await r.json()) as { group_key: string; v: string | number }[];
    const out = new Map<string, number>();
    for (const row of rows) out.set(row.group_key ?? "", Number(row.v));
    return out;
  }

  async function aggregateMetric(
    alert: schema.Alert,
    range: EvaluationRange,
  ): Promise<Map<string, number>> {
    if (!alert.metricName) return new Map();
    const attr = attrConds(alert.filter.resourceAttrs);
    const group = groupExprFor(alert.groupBy);

    const sums = new Map<string, number>();
    const counts = new Map<string, number>();
    for (const { table, valueExpr } of METRIC_SERIES_TABLES) {
      const conds: string[] = [
        "ResourceAttributes['superlog.project_id'] = {projectId:String}",
        "TimeUnix >= parseDateTime64BestEffortOrZero({since:String})",
        "TimeUnix <= parseDateTime64BestEffortOrZero({until:String})",
        "MetricName = {metricName:String}",
        ...attr.conds,
      ];
      if (alert.filter.service) conds.push("ServiceName = {service:String}");
      try {
        const r = await ch.query({
          query: `
            SELECT ${group.expr} AS group_key, ${valueExpr} AS v, count() AS n
            FROM ${table}
            WHERE ${conds.join(" AND ")}
            GROUP BY group_key
            LIMIT 1000
          `,
          query_params: {
            projectId: alert.projectId,
            since: range.since,
            until: range.until,
            metricName: alert.metricName,
            service: alert.filter.service ?? "",
            ...attr.params,
            ...group.params,
          },
          format: "JSONEachRow",
        });
        const rows = (await r.json()) as {
          group_key: string;
          v: string | number;
          n: string | number;
        }[];
        for (const row of rows) {
          const key = row.group_key ?? "";
          sums.set(key, (sums.get(key) ?? 0) + Number(row.v));
          counts.set(key, (counts.get(key) ?? 0) + Number(row.n));
        }
      } catch (err) {
        if (!isMissingTableError(err)) throw err;
      }
    }

    const out = new Map<string, number>();
    if (alert.aggregation === "avg") {
      for (const [key, sum] of sums) {
        const n = counts.get(key) ?? 1;
        out.set(key, n > 0 ? sum / n : 0);
      }
    } else {
      for (const [key, sum] of sums) out.set(key, sum);
    }
    return out;
  }

  return {
    async aggregate(alert: schema.Alert, range: EvaluationRange): Promise<Map<string, number>> {
      return alert.source === "metric"
        ? aggregateMetric(alert, range)
        : aggregateCount(alert, range);
    },
    // Exposed for direct use / tests; consider `aggregate` as the canonical entry.
    aggregateCount,
    aggregateMetric,
  };
}
