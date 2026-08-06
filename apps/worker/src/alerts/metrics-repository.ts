import type { ClickHouseClient } from "@clickhouse/client";
import type { schema } from "@superlog/db";
import { metricAggregate } from "@superlog/telemetry-query";
import type { EvaluationRange } from "./domain.js";

export type AlertMetricsRepository = ReturnType<typeof createAlertMetricsRepository>;

function attrConds(
  attrs: { key: string; value: string }[] | undefined,
  column = "ResourceAttributes",
  prefix = "aalert",
): {
  conds: string[];
  params: Record<string, string>;
} {
  const conds: string[] = [];
  const params: Record<string, string> = {};
  if (!attrs) return { conds, params };
  attrs.forEach((a, i) => {
    const k = `${prefix}_k_${i}`;
    const v = `${prefix}_v_${i}`;
    conds.push(`${column}[{${k}:String}] = {${v}:String}`);
    params[k] = a.key;
    params[v] = a.value;
  });
  return { conds, params };
}

function groupExprFor(
  groupBy: string | null | undefined,
  source: schema.AlertSource,
): {
  expr: string;
  params: Record<string, string>;
} {
  if (!groupBy) return { expr: "''", params: {} };
  if (groupBy === "service.name" || groupBy === "service") {
    return { expr: "ServiceName", params: {} };
  }
  if (groupBy.startsWith("log.") && source === "logs") {
    return {
      expr: "LogAttributes[{aalert_groupKey:String}]",
      params: { aalert_groupKey: groupBy.slice("log.".length) },
    };
  }
  if (groupBy.startsWith("span.") && source === "traces") {
    return {
      expr: "SpanAttributes[{aalert_groupKey:String}]",
      params: { aalert_groupKey: groupBy.slice("span.".length) },
    };
  }
  if (groupBy.startsWith("attr:")) {
    return {
      expr:
        source === "logs"
          ? "LogAttributes[{aalert_groupKey:String}]"
          : "SpanAttributes[{aalert_groupKey:String}]",
      params: { aalert_groupKey: groupBy.slice("attr:".length) },
    };
  }
  const resourceKey = groupBy.startsWith("resource.") ? groupBy.slice("resource.".length) : groupBy;
  return {
    expr: "ResourceAttributes[{aalert_groupKey:String}]",
    params: { aalert_groupKey: resourceKey },
  };
}

export function createAlertMetricsRepository(ch: ClickHouseClient) {
  async function aggregateCount(
    alert: schema.Alert,
    range: EvaluationRange,
  ): Promise<Map<string, number>> {
    const table = alert.source === "logs" ? "otel_logs" : "otel_traces";
    const attr = attrConds(alert.filter.resourceAttrs);
    const logAttr = attrConds(alert.filter.logAttrs, "LogAttributes", "aalert_log");
    const group = groupExprFor(alert.groupBy, alert.source);
    const conds: string[] = [
      "ResourceAttributes['superlog.project_id'] = {projectId:String}",
      "Timestamp >= parseDateTime64BestEffortOrZero({since:String})",
      "Timestamp <= parseDateTime64BestEffortOrZero({until:String})",
      ...attr.conds,
      ...(alert.source === "logs" ? logAttr.conds : []),
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
        ...(alert.source === "logs" ? logAttr.params : {}),
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
    const rows = await metricAggregate(
      ch,
      alert.projectId,
      alert.metricName,
      {
        range,
        service: alert.filter.service,
        resourceAttrs: alert.filter.resourceAttrs,
      },
      alert.groupBy ?? undefined,
      alert.aggregation === "avg" ? "avg" : "sum",
    );
    return new Map(rows.map((row) => [row.group ?? "", row.value]));
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
