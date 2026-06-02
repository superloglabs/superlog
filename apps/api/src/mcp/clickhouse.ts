import type { ClickHouseClient } from "@clickhouse/client";

export type TimeRange = { since?: string; until?: string };
export type ResourceAttrFilter = {
  key: string;
  value: string;
  op?: "eq" | "neq" | "not_contains";
};

type AttributeColumn = "ResourceAttributes" | "SpanAttributes" | "LogAttributes";
type AttributeScope = "resource" | "span" | "log";
type ParsedAttributeKey = { scope: AttributeScope; key: string };

const RELATIVE_TIME_EXPR_RE =
  /^now\(\)(?:\s*-\s*INTERVAL\s+(?:[1-9][0-9]*)\s+(?:SECOND|MINUTE|HOUR|DAY|WEEK|MONTH))?$/i;

function timeBoundExpr(value: string, paramName: "since" | "until"): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (RELATIVE_TIME_EXPR_RE.test(normalized)) return normalized;
  return `parseDateTime64BestEffortOrZero({${paramName}:String})`;
}

function resolveRange(range?: TimeRange): {
  sinceSql: string;
  untilSql: string;
  sinceExpr: string;
  untilExpr: string;
} {
  const since = range?.since ?? "now() - INTERVAL 1 HOUR";
  const until = range?.until ?? "now()";
  return {
    sinceSql: since,
    untilSql: until,
    sinceExpr: timeBoundExpr(since, "since"),
    untilExpr: timeBoundExpr(until, "until"),
  };
}

function attrConds(
  attrs: ResourceAttrFilter[] | undefined,
  column: AttributeColumn = "ResourceAttributes",
  paramPrefix = "attr",
): {
  conds: string[];
  params: Record<string, string>;
} {
  const conds: string[] = [];
  const params: Record<string, string> = {};
  if (!attrs) return { conds, params };
  attrs.forEach((a, i) => {
    const kName = `${paramPrefix}_k_${i}`;
    const vName = `${paramPrefix}_v_${i}`;
    if (a.op === "neq") {
      conds.push(`${column}[{${kName}:String}] != {${vName}:String}`);
    } else if (a.op === "not_contains") {
      conds.push(`positionCaseInsensitive(${column}[{${kName}:String}], {${vName}:String}) = 0`);
    } else {
      conds.push(`${column}[{${kName}:String}] = {${vName}:String}`);
    }
    params[kName] = a.key;
    params[vName] = a.value;
  });
  return { conds, params };
}

function parseAttributeKey(key: string): ParsedAttributeKey {
  if (key.startsWith("resource.")) return { scope: "resource", key: key.slice("resource.".length) };
  if (key.startsWith("span.")) return { scope: "span", key: key.slice("span.".length) };
  if (key.startsWith("log.")) return { scope: "log", key: key.slice("log.".length) };
  return { scope: "resource", key };
}

function splitAttrs(
  attrs: ResourceAttrFilter[] | undefined,
): Record<AttributeScope, ResourceAttrFilter[]> {
  const out: Record<AttributeScope, ResourceAttrFilter[]> = { resource: [], span: [], log: [] };
  for (const attr of attrs ?? []) {
    const parsed = parseAttributeKey(attr.key);
    out[parsed.scope].push({ ...attr, key: parsed.key });
  }
  return out;
}

function groupExprForAttribute(
  groupBy: string | undefined,
  source: SeriesSource,
): { expr: string; params: Record<string, string> } {
  if (groupBy === "service.name" || groupBy === "service") {
    return { expr: "ServiceName", params: {} };
  }
  if (groupBy?.startsWith("attr:")) {
    return {
      expr:
        source === "logs"
          ? "LogAttributes[{groupKey:String}]"
          : "SpanAttributes[{groupKey:String}]",
      params: { groupKey: groupBy.slice("attr:".length) },
    };
  }
  if (groupBy) {
    const parsed = parseAttributeKey(groupBy);
    if (parsed.scope === "resource") {
      return { expr: "ResourceAttributes[{groupKey:String}]", params: { groupKey: parsed.key } };
    }
    if (parsed.scope === "log" && source === "logs") {
      return { expr: "LogAttributes[{groupKey:String}]", params: { groupKey: parsed.key } };
    }
    if (parsed.scope === "span" && source === "traces") {
      return { expr: "SpanAttributes[{groupKey:String}]", params: { groupKey: parsed.key } };
    }
  }
  return { expr: "''", params: {} };
}

export async function queryLogs(
  ch: ClickHouseClient,
  projectId: string,
  params: {
    range?: TimeRange;
    service?: string;
    severity?: string;
    search?: string;
    traceId?: string;
    resourceAttrs?: ResourceAttrFilter[];
    logAttrs?: ResourceAttrFilter[];
    limit: number;
  },
) {
  const { sinceSql, untilSql, sinceExpr, untilExpr } = resolveRange(params.range);
  const split = splitAttrs(params.resourceAttrs);
  const attr = attrConds(split.resource);
  const logAttr = attrConds([...split.log, ...(params.logAttrs ?? [])], "LogAttributes", "lattr");
  const conds: string[] = [
    "ResourceAttributes['superlog.project_id'] = {projectId:String}",
    `Timestamp >= ${sinceExpr}`,
    `Timestamp <= ${untilExpr}`,
    ...attr.conds,
    ...logAttr.conds,
  ];
  if (params.service) conds.push("ServiceName = {service:String}");
  if (params.severity) conds.push("upper(SeverityText) = upper({severity:String})");
  if (params.search) conds.push("positionCaseInsensitive(Body, {search:String}) > 0");
  if (params.traceId) conds.push("TraceId = {traceId:String}");

  const query = `
    SELECT
      toString(Timestamp) AS timestamp,
      ServiceName AS service,
      SeverityText AS severity,
      toUInt8(SeverityNumber) AS severity_number,
      Body AS body,
      TraceId AS trace_id,
      SpanId AS span_id,
      LogAttributes AS log_attrs,
      ResourceAttributes AS resource_attrs
    FROM otel_logs
    WHERE ${conds.join(" AND ")}
    ORDER BY Timestamp DESC
    LIMIT {limit:UInt32}
  `;
  const r = await ch.query({
    query,
    query_params: {
      projectId,
      since: sinceSql,
      until: untilSql,
      service: params.service ?? "",
      severity: params.severity ?? "",
      search: params.search ?? "",
      traceId: params.traceId ?? "",
      limit: params.limit,
      ...attr.params,
      ...logAttr.params,
    },
    format: "JSONEachRow",
  });
  return r.json();
}

export async function queryTraces(
  ch: ClickHouseClient,
  projectId: string,
  params: {
    range?: TimeRange;
    service?: string;
    spanName?: string;
    statusCode?: string;
    minDurationMs?: number;
    resourceAttrs?: ResourceAttrFilter[];
    spanAttrs?: ResourceAttrFilter[];
    limit: number;
  },
) {
  const { sinceSql, untilSql, sinceExpr, untilExpr } = resolveRange(params.range);
  const split = splitAttrs(params.resourceAttrs);
  const attr = attrConds(split.resource);
  const spanAttr = attrConds(
    [...split.span, ...(params.spanAttrs ?? [])],
    "SpanAttributes",
    "sattr",
  );
  const conds: string[] = [
    "ResourceAttributes['superlog.project_id'] = {projectId:String}",
    `Timestamp >= ${sinceExpr}`,
    `Timestamp <= ${untilExpr}`,
    ...attr.conds,
    ...spanAttr.conds,
  ];
  if (params.service) conds.push("ServiceName = {service:String}");
  if (params.spanName) conds.push("SpanName = {spanName:String}");
  if (params.statusCode) conds.push("StatusCode = {statusCode:String}");
  if (typeof params.minDurationMs === "number") {
    conds.push("Duration >= {minDurationNs:UInt64}");
  }

  const query = `
    SELECT
      toString(Timestamp) AS timestamp,
      TraceId AS trace_id,
      SpanId AS span_id,
      ParentSpanId AS parent_span_id,
      ServiceName AS service,
      SpanName AS span_name,
      SpanKind AS span_kind,
      StatusCode AS status_code,
      StatusMessage AS status_message,
      Duration / 1000000 AS duration_ms,
      SpanAttributes AS span_attrs,
      ResourceAttributes AS resource_attrs
    FROM otel_traces
    WHERE ${conds.join(" AND ")}
    ORDER BY Timestamp DESC
    LIMIT {limit:UInt32}
  `;
  const r = await ch.query({
    query,
    query_params: {
      projectId,
      since: sinceSql,
      until: untilSql,
      service: params.service ?? "",
      spanName: params.spanName ?? "",
      statusCode: params.statusCode ?? "",
      minDurationNs: Math.round((params.minDurationMs ?? 0) * 1_000_000),
      limit: params.limit,
      ...attr.params,
      ...spanAttr.params,
    },
    format: "JSONEachRow",
  });
  return r.json();
}

export async function queryTracesAggregated(
  ch: ClickHouseClient,
  projectId: string,
  params: {
    range?: TimeRange;
    service?: string;
    spanName?: string;
    statusCode?: string;
    minDurationMs?: number;
    resourceAttrs?: ResourceAttrFilter[];
    limit: number;
  },
) {
  const { sinceSql, untilSql, sinceExpr, untilExpr } = resolveRange(params.range);
  const split = splitAttrs(params.resourceAttrs);
  const attr = attrConds(split.resource);
  const spanAttr = attrConds(split.span, "SpanAttributes", "sattr");
  // Outer scope: trace-level. We aggregate over every span of every matching
  // trace in the window so span_count / duration_ms / error_count describe the
  // whole trace rather than only the spans matching span-level filters.
  const outerConds: string[] = [
    "ResourceAttributes['superlog.project_id'] = {projectId:String}",
    `Timestamp >= ${sinceExpr}`,
    `Timestamp <= ${untilExpr}`,
    ...attr.conds,
  ];
  // Inner scope: span-level filters pick which TraceIds qualify.
  const innerConds: string[] = [...outerConds, ...spanAttr.conds];
  if (params.service) innerConds.push("ServiceName = {service:String}");
  if (params.spanName) innerConds.push("SpanName = {spanName:String}");
  if (params.statusCode) innerConds.push("StatusCode = {statusCode:String}");
  const hasSpanLevelFilter = !!(
    params.service ||
    params.spanName ||
    params.statusCode ||
    spanAttr.conds.length
  );

  // After GROUP BY TraceId, filter by total duration if requested.
  const havingMinDuration =
    typeof params.minDurationMs === "number" && params.minDurationMs > 0
      ? `HAVING duration_ms >= ${Math.round(params.minDurationMs * 1000) / 1000}`
      : "";

  const traceIdSubquery = hasSpanLevelFilter
    ? `AND TraceId IN (
        SELECT DISTINCT TraceId FROM otel_traces
        WHERE ${innerConds.join(" AND ")}
      )`
    : "";

  const query = `
    SELECT
      TraceId AS trace_id,
      toString(min(Timestamp)) AS start_time,
      argMin(SpanName, Timestamp) AS root_span_name,
      argMin(ServiceName, Timestamp) AS root_service,
      argMin(StatusCode, Timestamp) AS root_status_code,
      count() AS span_count,
      countIf(StatusCode = 'STATUS_CODE_ERROR') AS error_count,
      uniqExact(ServiceName) AS service_count,
      toFloat64(
        max(toUnixTimestamp64Nano(Timestamp) + Duration) -
        min(toUnixTimestamp64Nano(Timestamp))
      ) / 1000000 AS duration_ms
    FROM otel_traces
    WHERE ${outerConds.join(" AND ")}
      ${traceIdSubquery}
    GROUP BY TraceId
    ${havingMinDuration}
    ORDER BY min(Timestamp) DESC
    LIMIT {limit:UInt32}
  `;
  const r = await ch.query({
    query,
    query_params: {
      projectId,
      since: sinceSql,
      until: untilSql,
      service: params.service ?? "",
      spanName: params.spanName ?? "",
      statusCode: params.statusCode ?? "",
      limit: params.limit,
      ...attr.params,
      ...spanAttr.params,
    },
    format: "JSONEachRow",
  });
  return r.json();
}

export async function getTraceDetail(ch: ClickHouseClient, projectId: string, traceId: string) {
  const spansQ = ch.query({
    query: `
      SELECT
        toString(Timestamp) AS timestamp,
        toString(toUnixTimestamp64Nano(Timestamp)) AS start_ns,
        TraceId AS trace_id,
        SpanId AS span_id,
        ParentSpanId AS parent_span_id,
        ServiceName AS service,
        SpanName AS span_name,
        SpanKind AS span_kind,
        StatusCode AS status_code,
        StatusMessage AS status_message,
        toString(Duration) AS duration_ns,
        toFloat64(Duration) / 1000000 AS duration_ms,
        SpanAttributes AS span_attrs,
        ResourceAttributes AS resource_attrs
      FROM otel_traces
      WHERE ResourceAttributes['superlog.project_id'] = {projectId:String}
        AND TraceId = {traceId:String}
      ORDER BY Timestamp ASC, SpanId ASC
      LIMIT 5000
    `,
    query_params: { projectId, traceId },
    format: "JSONEachRow",
  });

  const logsQ = ch.query({
    query: `
      SELECT
        toString(Timestamp) AS timestamp,
        toString(toUnixTimestamp64Nano(Timestamp)) AS ts_ns,
        ServiceName AS service,
        SeverityText AS severity,
        Body AS body,
        TraceId AS trace_id,
        SpanId AS span_id,
        LogAttributes AS log_attrs
      FROM otel_logs
      WHERE ResourceAttributes['superlog.project_id'] = {projectId:String}
        AND TraceId = {traceId:String}
      ORDER BY Timestamp ASC
      LIMIT 5000
    `,
    query_params: { projectId, traceId },
    format: "JSONEachRow",
  });

  const [spansR, logsR] = await Promise.all([spansQ, logsQ]);
  const spans = await spansR.json();
  const logs = await logsR.json();
  return { spans, logs };
}

export async function queryMetrics(
  ch: ClickHouseClient,
  projectId: string,
  params: {
    metricName?: string;
    service?: string;
    range?: TimeRange;
    resourceAttrs?: ResourceAttrFilter[];
    limit: number;
  },
) {
  const { sinceSql, untilSql, sinceExpr, untilExpr } = resolveRange(params.range);
  const attr = attrConds(params.resourceAttrs);
  const results: Record<string, unknown>[] = [];

  for (const { table, kind } of METRIC_TABLES) {
    const conds: string[] = [
      "ResourceAttributes['superlog.project_id'] = {projectId:String}",
      `TimeUnix >= ${sinceExpr}`,
      `TimeUnix <= ${untilExpr}`,
      ...attr.conds,
    ];
    if (params.metricName) conds.push("MetricName = {metricName:String}");
    if (params.service) conds.push("ResourceAttributes['service.name'] = {service:String}");

    // Histograms/summaries have no scalar Value; surface the rolled-up
    // Count/Sum (and Min/Max for histograms) so a point conveys more than just
    // "an observation happened". Min/Max don't exist on the summary table.
    const valueExpr =
      kind === "histogram"
        ? "NULL AS value, Count AS count, Sum AS sum, Min AS min, Max AS max"
        : kind === "summary"
          ? "NULL AS value, Count AS count, Sum AS sum, NULL AS min, NULL AS max"
          : "Value AS value, NULL AS count, NULL AS sum, NULL AS min, NULL AS max";

    const query = `
      SELECT
        '${kind}' AS kind,
        toString(TimeUnix) AS timestamp,
        MetricName AS metric_name,
        MetricUnit AS unit,
        ResourceAttributes['service.name'] AS service,
        ${valueExpr},
        Attributes AS attributes,
        ResourceAttributes AS resource_attrs
      FROM ${table}
      WHERE ${conds.join(" AND ")}
      ORDER BY TimeUnix DESC
      LIMIT {limit:UInt32}
    `;

    try {
      const r = await ch.query({
        query,
        query_params: {
          projectId,
          since: sinceSql,
          until: untilSql,
          metricName: params.metricName ?? "",
          service: params.service ?? "",
          limit: params.limit,
          ...attr.params,
        },
        format: "JSONEachRow",
      });
      const rows = (await r.json()) as Record<string, unknown>[];
      results.push(...rows);
    } catch (err) {
      // metric tables may not exist if no metrics of this kind have been ingested yet
      if (!(err instanceof Error && /UNKNOWN_TABLE|doesn't exist/i.test(err.message))) throw err;
    }
  }

  results.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  return results.slice(0, params.limit);
}

export async function listServices(ch: ClickHouseClient, projectId: string, range?: TimeRange) {
  const { sinceSql, untilSql, sinceExpr, untilExpr } = resolveRange(range);
  const query = `
    SELECT DISTINCT ServiceName AS service
    FROM otel_traces
    WHERE ResourceAttributes['superlog.project_id'] = {projectId:String}
      AND Timestamp >= ${sinceExpr}
      AND Timestamp <= ${untilExpr}
      AND ServiceName != ''
    ORDER BY service
    LIMIT 200
  `;
  const r = await ch.query({
    query,
    query_params: { projectId, since: sinceSql, until: untilSql },
    format: "JSONEachRow",
  });
  const rows = (await r.json()) as { service: string }[];
  return rows.map((r) => r.service);
}

export async function listAttributeKeys(
  ch: ClickHouseClient,
  projectId: string,
  range?: TimeRange,
  source?: SeriesSource | "metrics",
): Promise<{ key: string; count: number }[]> {
  const { sinceSql, untilSql, sinceExpr, untilExpr } = resolveRange(range);
  const resourceFromLogs = source === undefined || source === "logs" || source === "metrics";
  const resourceFromTraces = source === undefined || source === "traces" || source === "metrics";
  const subqueries: string[] = [];
  if (source === undefined) {
    subqueries.push(`
      SELECT arrayJoin(mapKeys(ResourceAttributes)) AS k, count() AS c
      FROM otel_logs
      WHERE ResourceAttributes['superlog.project_id'] = {projectId:String}
        AND Timestamp >= ${sinceExpr}
        AND Timestamp <= ${untilExpr}
      GROUP BY k`);
    subqueries.push(`
      SELECT arrayJoin(mapKeys(ResourceAttributes)) AS k, count() AS c
      FROM otel_traces
      WHERE ResourceAttributes['superlog.project_id'] = {projectId:String}
        AND Timestamp >= ${sinceExpr}
        AND Timestamp <= ${untilExpr}
      GROUP BY k`);
  } else {
    if (resourceFromLogs) {
      subqueries.push(`
      SELECT concat('resource.', k) AS k, c FROM (
        SELECT arrayJoin(mapKeys(ResourceAttributes)) AS k, count() AS c
        FROM otel_logs
        WHERE ResourceAttributes['superlog.project_id'] = {projectId:String}
          AND Timestamp >= ${sinceExpr}
          AND Timestamp <= ${untilExpr}
        GROUP BY k
      )`);
    }
    if (source === "logs") {
      subqueries.push(`
      SELECT concat('log.', k) AS k, c FROM (
        SELECT arrayJoin(mapKeys(LogAttributes)) AS k, count() AS c
        FROM otel_logs
        WHERE ResourceAttributes['superlog.project_id'] = {projectId:String}
          AND Timestamp >= ${sinceExpr}
          AND Timestamp <= ${untilExpr}
        GROUP BY k
      )`);
    }
    if (resourceFromTraces) {
      subqueries.push(`
      SELECT concat('resource.', k) AS k, c FROM (
        SELECT arrayJoin(mapKeys(ResourceAttributes)) AS k, count() AS c
        FROM otel_traces
        WHERE ResourceAttributes['superlog.project_id'] = {projectId:String}
          AND Timestamp >= ${sinceExpr}
          AND Timestamp <= ${untilExpr}
        GROUP BY k
      )`);
    }
    if (source === "traces") {
      subqueries.push(`
      SELECT concat('span.', k) AS k, c FROM (
        SELECT arrayJoin(mapKeys(SpanAttributes)) AS k, count() AS c
        FROM otel_traces
        WHERE ResourceAttributes['superlog.project_id'] = {projectId:String}
          AND Timestamp >= ${sinceExpr}
          AND Timestamp <= ${untilExpr}
        GROUP BY k
      )`);
    }
  }
  const query = `
    SELECT k, sum(c) AS c FROM (
      ${subqueries.join("\n      UNION ALL\n")}
    )
    WHERE k != 'superlog.project_id' AND k != 'resource.superlog.project_id' AND k != ''
    GROUP BY k
    ORDER BY c DESC
    LIMIT 200
  `;
  const r = await ch.query({
    query,
    query_params: { projectId, since: sinceSql, until: untilSql },
    format: "JSONEachRow",
  });
  const rows = (await r.json()) as { k: string; c: string | number }[];
  return rows.map((row) => ({ key: row.k, count: Number(row.c) }));
}

export async function listAttributeValues(
  ch: ClickHouseClient,
  projectId: string,
  key: string,
  range?: TimeRange,
  limit = 200,
  source?: SeriesSource | "metrics",
): Promise<{ value: string; count: number }[]> {
  const { sinceSql, untilSql, sinceExpr, untilExpr } = resolveRange(range);
  const parsed = parseAttributeKey(key);
  const keyParam = parsed.key;
  const subqueries: string[] = [];
  if (parsed.scope === "resource") {
    if (source === undefined || source === "logs" || source === "metrics") {
      subqueries.push(`
      SELECT ResourceAttributes[{key:String}] AS v, count() AS c
      FROM otel_logs
      WHERE ResourceAttributes['superlog.project_id'] = {projectId:String}
        AND Timestamp >= ${sinceExpr}
        AND Timestamp <= ${untilExpr}
        AND mapContains(ResourceAttributes, {key:String})
      GROUP BY v`);
    }
    if (source === undefined || source === "traces" || source === "metrics") {
      subqueries.push(`
      SELECT ResourceAttributes[{key:String}] AS v, count() AS c
      FROM otel_traces
      WHERE ResourceAttributes['superlog.project_id'] = {projectId:String}
        AND Timestamp >= ${sinceExpr}
        AND Timestamp <= ${untilExpr}
        AND mapContains(ResourceAttributes, {key:String})
      GROUP BY v`);
    }
  } else if (parsed.scope === "log" && source === "logs") {
    subqueries.push(`
      SELECT LogAttributes[{key:String}] AS v, count() AS c
      FROM otel_logs
      WHERE ResourceAttributes['superlog.project_id'] = {projectId:String}
        AND Timestamp >= ${sinceExpr}
        AND Timestamp <= ${untilExpr}
        AND mapContains(LogAttributes, {key:String})
      GROUP BY v`);
  } else if (parsed.scope === "span" && source === "traces") {
    subqueries.push(`
      SELECT SpanAttributes[{key:String}] AS v, count() AS c
      FROM otel_traces
      WHERE ResourceAttributes['superlog.project_id'] = {projectId:String}
        AND Timestamp >= ${sinceExpr}
        AND Timestamp <= ${untilExpr}
        AND mapContains(SpanAttributes, {key:String})
      GROUP BY v`);
  }
  if (subqueries.length === 0) return [];
  const query = `
    SELECT v, sum(c) AS c FROM (
      ${subqueries.join("\n      UNION ALL\n")}
    )
    WHERE v != ''
    GROUP BY v
    ORDER BY c DESC
    LIMIT {limit:UInt32}
  `;
  const r = await ch.query({
    query,
    query_params: { projectId, key: keyParam, since: sinceSql, until: untilSql, limit },
    format: "JSONEachRow",
  });
  const rows = (await r.json()) as { v: string; c: string | number }[];
  return rows.map((row) => ({ value: row.v, count: Number(row.c) }));
}

export type MetricKind = "gauge" | "sum" | "histogram" | "summary";
export type MetricName = { name: string; kind: MetricKind; unit: string };
export type MetricSeriesRow = { bucket: string; group: string; value: number };

export const METRIC_AGGREGATIONS = ["sum", "avg", "min", "max", "p95", "p99"] as const;
export type MetricAggregation = (typeof METRIC_AGGREGATIONS)[number];

const METRIC_TABLES: { table: string; kind: MetricKind }[] = [
  { table: "otel_metrics_gauge", kind: "gauge" },
  { table: "otel_metrics_sum", kind: "sum" },
  { table: "otel_metrics_histogram", kind: "histogram" },
  { table: "otel_metrics_summary", kind: "summary" },
];

// Default per-kind aggregation when the caller doesn't specify one.
const DEFAULT_AGG_EXPR: Record<MetricKind, string> = {
  gauge: "avg(Value)",
  sum: "sum(Value)",
  histogram: "toFloat64(sum(Count))",
  summary: "avg(Sum)",
};

// Per-aggregation, per-kind ClickHouse expression. `null` means "this aggregation
// is not supported on this metric kind" — we skip the table for that query.
//
// Histograms and summaries have no scalar Value column. We map sum/avg onto the
// rolled-up Sum/Count columns. min/max use Min/Max where present (histogram only).
// True quantile reconstruction from histogram bucket arrays / summary
// ValueAtQuantiles is non-trivial and intentionally not supported here.
const AGG_EXPR: Record<MetricAggregation, Partial<Record<MetricKind, string>>> = {
  sum: {
    gauge: "sum(Value)",
    sum: "sum(Value)",
    histogram: "sum(Sum)",
    summary: "sum(Sum)",
  },
  avg: {
    gauge: "avg(Value)",
    sum: "avg(Value)",
    histogram: "sum(Sum) / nullIf(toFloat64(sum(Count)), 0)",
    summary: "sum(Sum) / nullIf(toFloat64(sum(Count)), 0)",
  },
  min: {
    gauge: "min(Value)",
    sum: "min(Value)",
    histogram: "min(Min)",
  },
  max: {
    gauge: "max(Value)",
    sum: "max(Value)",
    histogram: "max(Max)",
  },
  p95: {
    gauge: "quantile(0.95)(Value)",
    sum: "quantile(0.95)(Value)",
    // histogram handled via ARRAY JOIN path below — see histogramQuantileQuery.
    histogram: "__histogram_quantile__",
  },
  p99: {
    gauge: "quantile(0.99)(Value)",
    sum: "quantile(0.99)(Value)",
    histogram: "__histogram_quantile__",
  },
};

// Histograms have no scalar Value column — quantiles must be reconstructed from
// BucketCounts + ExplicitBounds. We approximate by treating each bucket's upper
// bound as its representative value (the overflow bucket falls back to Max,
// or the largest finite bound if Max wasn't recorded), then run
// quantileExactWeighted with bucket counts as weights. This biases the result
// up by less than one bucket width — the same approximation Prometheus's
// histogram_quantile uses, minus the within-bucket linear interpolation.
function histogramQuantileQuery(args: {
  table: string;
  step: Step;
  groupExpr: string;
  conds: string[];
  q: number;
}): string {
  const { table, step, groupExpr, conds, q } = args;
  return `
    SELECT
      toString(toStartOfInterval(TimeUnix, INTERVAL ${step.n} ${step.unit})) AS bucket,
      ${groupExpr} AS group_key,
      quantileExactWeighted(${q})(
        if(
          idx <= length(ExplicitBounds),
          ExplicitBounds[idx],
          if(Max > 0, Max, ExplicitBounds[length(ExplicitBounds)])
        ),
        BucketCounts[idx]
      ) AS v
    FROM ${table}
    ARRAY JOIN arrayEnumerate(BucketCounts) AS idx
    WHERE ${conds.join(" AND ")} AND BucketCounts[idx] > 0
    GROUP BY bucket, group_key
    ORDER BY bucket ASC
    LIMIT 10000
  `;
}

export async function listMetricNames(
  ch: ClickHouseClient,
  projectId: string,
  range?: TimeRange,
): Promise<MetricName[]> {
  const { sinceSql, untilSql, sinceExpr, untilExpr } = resolveRange(range);
  const results: MetricName[] = [];
  for (const { table, kind } of METRIC_TABLES) {
    try {
      const r = await ch.query({
        query: `
          SELECT MetricName AS name, MetricUnit AS unit, count() AS c
          FROM ${table}
          WHERE ResourceAttributes['superlog.project_id'] = {projectId:String}
            AND TimeUnix >= ${sinceExpr}
            AND TimeUnix <= ${untilExpr}
          GROUP BY name, unit
          ORDER BY c DESC
          LIMIT 200
        `,
        query_params: { projectId, since: sinceSql, until: untilSql },
        format: "JSONEachRow",
      });
      const rows = (await r.json()) as { name: string; unit: string; c: string | number }[];
      for (const row of rows) results.push({ name: row.name, kind, unit: row.unit });
    } catch (err) {
      if (!(err instanceof Error && /UNKNOWN_TABLE|doesn't exist/i.test(err.message))) throw err;
    }
  }
  return results;
}

export type MetricSeriesFilter = {
  range?: TimeRange;
  service?: string;
  resourceAttrs?: ResourceAttrFilter[];
};

export async function metricSeries(
  ch: ClickHouseClient,
  projectId: string,
  metricName: string,
  filter: MetricSeriesFilter,
  groupBy: string | undefined,
  step: Step,
  aggregation?: MetricAggregation,
): Promise<MetricSeriesRow[]> {
  const { sinceSql, untilSql, sinceExpr, untilExpr } = resolveRange(filter.range);
  const attr = attrConds(filter.resourceAttrs);

  let groupExpr = "''";
  const groupParams: Record<string, string> = {};
  if (groupBy === "service.name" || groupBy === "service") {
    groupExpr = "ServiceName";
  } else if (groupBy?.startsWith("attr:")) {
    // `attr:<key>` groups by metric data-point attributes, not resource
    // attributes — needed when the per-observation dimension differs from
    // the producing service (e.g. `attr:tenant.org.name` for self-emitted
    // gauges that fan out across orgs).
    groupExpr = "Attributes[{groupKey:String}]";
    groupParams.groupKey = groupBy.slice("attr:".length);
  } else if (groupBy) {
    groupExpr = "ResourceAttributes[{groupKey:String}]";
    groupParams.groupKey = groupBy;
  }

  const results: MetricSeriesRow[] = [];
  for (const { table, kind } of METRIC_TABLES) {
    const valueExpr = aggregation ? AGG_EXPR[aggregation][kind] : DEFAULT_AGG_EXPR[kind];
    if (!valueExpr) continue;
    const conds: string[] = [
      "ResourceAttributes['superlog.project_id'] = {projectId:String}",
      `TimeUnix >= ${sinceExpr}`,
      `TimeUnix <= ${untilExpr}`,
      "MetricName = {metricName:String}",
      ...attr.conds,
    ];
    if (filter.service) conds.push("ServiceName = {service:String}");
    const query =
      kind === "histogram" && (aggregation === "p95" || aggregation === "p99")
        ? histogramQuantileQuery({
            table,
            step,
            groupExpr,
            conds,
            q: aggregation === "p95" ? 0.95 : 0.99,
          })
        : `
          SELECT
            toString(toStartOfInterval(TimeUnix, INTERVAL ${step.n} ${step.unit})) AS bucket,
            ${groupExpr} AS group_key,
            ${valueExpr} AS v
          FROM ${table}
          WHERE ${conds.join(" AND ")}
          GROUP BY bucket, group_key
          ORDER BY bucket ASC
          LIMIT 10000
        `;
    try {
      const r = await ch.query({
        query,
        query_params: {
          projectId,
          since: sinceSql,
          until: untilSql,
          metricName,
          service: filter.service ?? "",
          ...attr.params,
          ...groupParams,
        },
        format: "JSONEachRow",
      });
      const rows = (await r.json()) as {
        bucket: string;
        group_key: string;
        v: string | number | null;
      }[];
      for (const row of rows) {
        if (row.v === null) continue;
        const value = Number(row.v);
        if (!Number.isFinite(value)) continue;
        results.push({ bucket: row.bucket, group: row.group_key, value });
      }
    } catch (err) {
      if (
        !(
          err instanceof Error &&
          /UNKNOWN_TABLE|UNKNOWN_IDENTIFIER|doesn't exist/i.test(err.message)
        )
      )
        throw err;
    }
  }
  results.sort((a, b) => a.bucket.localeCompare(b.bucket));
  return results;
}

export type SeriesSource = "logs" | "traces";

export type SeriesFilter = {
  range?: TimeRange;
  service?: string;
  resourceAttrs?: ResourceAttrFilter[];
  search?: string;
  severity?: string;
  spanName?: string;
  statusCode?: string;
  minDurationMs?: number;
};

export type StepUnit = "SECOND" | "MINUTE" | "HOUR" | "DAY";
export type Step = { n: number; unit: StepUnit };

const STEP_LADDER: Step[] = [
  { n: 1, unit: "SECOND" },
  { n: 5, unit: "SECOND" },
  { n: 15, unit: "SECOND" },
  { n: 30, unit: "SECOND" },
  { n: 1, unit: "MINUTE" },
  { n: 5, unit: "MINUTE" },
  { n: 15, unit: "MINUTE" },
  { n: 30, unit: "MINUTE" },
  { n: 1, unit: "HOUR" },
  { n: 3, unit: "HOUR" },
  { n: 6, unit: "HOUR" },
  { n: 12, unit: "HOUR" },
  { n: 1, unit: "DAY" },
];

function stepSeconds(step: Step): number {
  const mult =
    step.unit === "SECOND" ? 1 : step.unit === "MINUTE" ? 60 : step.unit === "HOUR" ? 3600 : 86400;
  return step.n * mult;
}

export function pickStep(rangeSeconds: number, targetBuckets = 120): Step {
  const ideal = Math.max(1, rangeSeconds / targetBuckets);
  for (const s of STEP_LADDER) {
    if (stepSeconds(s) >= ideal) return s;
  }
  return STEP_LADDER[STEP_LADDER.length - 1] ?? { n: 1, unit: "DAY" };
}

export async function countSeries(
  ch: ClickHouseClient,
  projectId: string,
  source: SeriesSource,
  filter: SeriesFilter,
  groupBy: string | undefined,
  step: Step,
): Promise<{ bucket: string; group: string; count: number }[]> {
  const { sinceSql, untilSql, sinceExpr, untilExpr } = resolveRange(filter.range);
  const split = splitAttrs(filter.resourceAttrs);
  const attr = attrConds(split.resource);
  const eventAttr =
    source === "logs"
      ? attrConds(split.log, "LogAttributes", "event_attr")
      : attrConds(split.span, "SpanAttributes", "event_attr");
  const table = source === "logs" ? "otel_logs" : "otel_traces";
  const conds: string[] = [
    "ResourceAttributes['superlog.project_id'] = {projectId:String}",
    `Timestamp >= ${sinceExpr}`,
    `Timestamp <= ${untilExpr}`,
    ...attr.conds,
    ...eventAttr.conds,
  ];
  if (filter.service) conds.push("ServiceName = {service:String}");
  if (source === "logs") {
    if (filter.severity) conds.push("upper(SeverityText) = upper({severity:String})");
    if (filter.search) conds.push("positionCaseInsensitive(Body, {search:String}) > 0");
  } else {
    if (filter.spanName) conds.push("SpanName = {spanName:String}");
    if (filter.statusCode) conds.push("StatusCode = {statusCode:String}");
    if (typeof filter.minDurationMs === "number") {
      conds.push("Duration >= {minDurationNs:UInt64}");
    }
  }

  const group = groupExprForAttribute(groupBy, source);

  const query = `
    SELECT
      toString(toStartOfInterval(Timestamp, INTERVAL ${step.n} ${step.unit})) AS bucket,
      ${group.expr} AS group_key,
      count() AS c
    FROM ${table}
    WHERE ${conds.join(" AND ")}
    GROUP BY bucket, group_key
    ORDER BY bucket ASC
    LIMIT 10000
  `;

  const r = await ch.query({
    query,
    query_params: {
      projectId,
      since: sinceSql,
      until: untilSql,
      service: filter.service ?? "",
      severity: filter.severity ?? "",
      search: filter.search ?? "",
      spanName: filter.spanName ?? "",
      statusCode: filter.statusCode ?? "",
      minDurationNs: Math.round((filter.minDurationMs ?? 0) * 1_000_000),
      ...attr.params,
      ...eventAttr.params,
      ...group.params,
    },
    format: "JSONEachRow",
  });
  const rows = (await r.json()) as { bucket: string; group_key: string; c: string | number }[];
  return rows.map((row) => ({ bucket: row.bucket, group: row.group_key, count: Number(row.c) }));
}

// -----------------------------------------------------------------------------
// Issue filter picker: keys, values, and recent-event preview drawn from
// ERROR events only. These mirror exactly what the worker considers an "error"
// in tickSpans / tickLogs (apps/worker/src/index.ts) so the picker shows the
// same population the filter actually applies to.
// -----------------------------------------------------------------------------

// Suggestions are drawn from ALL events in the window (not just errors) so the
// user can pre-configure a filter like env:prod before any errors have
// occurred. The filter itself only ever takes effect on errors — see the
// preview query below, which IS errors-only so the user can sanity-check what
// will actually be dropped.
export async function listIssueFilterAttributeKeys(
  ch: ClickHouseClient,
  projectId: string,
  range?: TimeRange,
): Promise<{ key: string; count: number }[]> {
  const { sinceSql, untilSql, sinceExpr, untilExpr } = resolveRange(range);
  const query = `
    SELECT k, sum(c) AS c FROM (
      SELECT arrayJoin(mapKeys(ResourceAttributes)) AS k, count() AS c
      FROM otel_logs
      WHERE ResourceAttributes['superlog.project_id'] = {projectId:String}
        AND Timestamp >= ${sinceExpr}
        AND Timestamp <= ${untilExpr}
      GROUP BY k
      UNION ALL
      SELECT arrayJoin(mapKeys(LogAttributes)) AS k, count() AS c
      FROM otel_logs
      WHERE ResourceAttributes['superlog.project_id'] = {projectId:String}
        AND Timestamp >= ${sinceExpr}
        AND Timestamp <= ${untilExpr}
      GROUP BY k
      UNION ALL
      SELECT arrayJoin(mapKeys(ResourceAttributes)) AS k, count() AS c
      FROM otel_traces
      WHERE ResourceAttributes['superlog.project_id'] = {projectId:String}
        AND Timestamp >= ${sinceExpr}
        AND Timestamp <= ${untilExpr}
      GROUP BY k
      UNION ALL
      SELECT arrayJoin(mapKeys(SpanAttributes)) AS k, count() AS c
      FROM otel_traces
      WHERE ResourceAttributes['superlog.project_id'] = {projectId:String}
        AND Timestamp >= ${sinceExpr}
        AND Timestamp <= ${untilExpr}
      GROUP BY k
    )
    WHERE k != 'superlog.project_id' AND k != ''
    GROUP BY k
    ORDER BY c DESC
    LIMIT 200
  `;
  const r = await ch.query({
    query,
    query_params: { projectId, since: sinceSql, until: untilSql },
    format: "JSONEachRow",
  });
  const rows = (await r.json()) as { k: string; c: string | number }[];
  return rows.map((row) => ({ key: row.k, count: Number(row.c) }));
}

export async function listIssueFilterAttributeValues(
  ch: ClickHouseClient,
  projectId: string,
  key: string,
  range?: TimeRange,
  limit = 200,
): Promise<{ value: string; count: number }[]> {
  const { sinceSql, untilSql, sinceExpr, untilExpr } = resolveRange(range);
  const query = `
    SELECT v, sum(c) AS c FROM (
      SELECT ResourceAttributes[{key:String}] AS v, count() AS c
      FROM otel_logs
      WHERE ResourceAttributes['superlog.project_id'] = {projectId:String}
        AND Timestamp >= ${sinceExpr}
        AND Timestamp <= ${untilExpr}
        AND mapContains(ResourceAttributes, {key:String})
      GROUP BY v
      UNION ALL
      SELECT LogAttributes[{key:String}] AS v, count() AS c
      FROM otel_logs
      WHERE ResourceAttributes['superlog.project_id'] = {projectId:String}
        AND Timestamp >= ${sinceExpr}
        AND Timestamp <= ${untilExpr}
        AND mapContains(LogAttributes, {key:String})
      GROUP BY v
      UNION ALL
      SELECT ResourceAttributes[{key:String}] AS v, count() AS c
      FROM otel_traces
      WHERE ResourceAttributes['superlog.project_id'] = {projectId:String}
        AND Timestamp >= ${sinceExpr}
        AND Timestamp <= ${untilExpr}
        AND mapContains(ResourceAttributes, {key:String})
      GROUP BY v
      UNION ALL
      SELECT SpanAttributes[{key:String}] AS v, count() AS c
      FROM otel_traces
      WHERE ResourceAttributes['superlog.project_id'] = {projectId:String}
        AND Timestamp >= ${sinceExpr}
        AND Timestamp <= ${untilExpr}
        AND mapContains(SpanAttributes, {key:String})
      GROUP BY v
    )
    WHERE v != ''
    GROUP BY v
    ORDER BY c DESC
    LIMIT {limit:UInt32}
  `;
  const r = await ch.query({
    query,
    query_params: { projectId, key, since: sinceSql, until: untilSql, limit },
    format: "JSONEachRow",
  });
  const rows = (await r.json()) as { v: string; c: string | number }[];
  return rows.map((row) => ({ value: row.v, count: Number(row.c) }));
}

export type IssueFilterClause = { key: string; value: string };

export type IssueFilterConfig = {
  includeLogs: IssueFilterClause[];
  includeSpans: IssueFilterClause[];
  excludeLogs: IssueFilterClause[];
  excludeSpans: IssueFilterClause[];
};

export type IssueFilterPreviewEvent = {
  kind: "log" | "span";
  ts: string;
  service: string;
  message: string;
  exception_type: string;
  attrs: Record<string, string>;
};

// Returns the most recent ERROR events that survive the filter:
//   - dropped if ANY exclude-clause for its kind matches
//   - if include-clause list for its kind is non-empty, must match at least one
// Empty config = preview unfiltered errors.
export async function previewIssueFilterMatches(
  ch: ClickHouseClient,
  projectId: string,
  config: IssueFilterConfig,
  range?: TimeRange,
  limit = 10,
): Promise<IssueFilterPreviewEvent[]> {
  const { sinceSql, untilSql, sinceExpr, untilExpr } = resolveRange(range);
  const params: Record<string, string | number> = {
    projectId,
    since: sinceSql,
    until: untilSql,
    limit,
  };
  // For each clause: case-insensitive key match across two attribute maps.
  // matchInMap returns true if any (key, value) entry in the map satisfies
  // lower(key) = clause.key AND value = clause.value.
  let nextParamIdx = 0;
  function registerClause(clause: IssueFilterClause): { k: string; v: string } {
    const kName = `clause_k_${nextParamIdx}`;
    const vName = `clause_v_${nextParamIdx}`;
    params[kName] = clause.key.toLowerCase();
    params[vName] = clause.value;
    nextParamIdx += 1;
    return { k: kName, v: vName };
  }
  function matchInMap(col: string, p: { k: string; v: string }): string {
    return `arrayExists(
      i -> lower(mapKeys(${col})[i]) = {${p.k}:String} AND mapValues(${col})[i] = {${p.v}:String},
      arrayEnumerate(mapKeys(${col}))
    )`;
  }
  function clauseSql(
    clauses: IssueFilterClause[],
    resourceCol: "ResourceAttributes",
    attrCol: "LogAttributes" | "SpanAttributes",
  ): string[] {
    return clauses.map((clause) => {
      const p = registerClause(clause);
      return `(${matchInMap(resourceCol, p)} OR ${matchInMap(attrCol, p)})`;
    });
  }
  const logIncludes = clauseSql(config.includeLogs, "ResourceAttributes", "LogAttributes");
  const logExcludes = clauseSql(config.excludeLogs, "ResourceAttributes", "LogAttributes");
  const spanIncludes = clauseSql(config.includeSpans, "ResourceAttributes", "SpanAttributes");
  const spanExcludes = clauseSql(config.excludeSpans, "ResourceAttributes", "SpanAttributes");

  // Includes are OR-within-bucket; excludes are NOT (any-match).
  const logFilterParts: string[] = [];
  if (logIncludes.length) logFilterParts.push(`(${logIncludes.join(" OR ")})`);
  if (logExcludes.length) logFilterParts.push(`NOT (${logExcludes.join(" OR ")})`);
  const spanFilterParts: string[] = [];
  if (spanIncludes.length) spanFilterParts.push(`(${spanIncludes.join(" OR ")})`);
  if (spanExcludes.length) spanFilterParts.push(`NOT (${spanExcludes.join(" OR ")})`);
  const logFilter = logFilterParts.length ? `AND ${logFilterParts.join(" AND ")}` : "";
  const spanFilter = spanFilterParts.length ? `AND ${spanFilterParts.join(" AND ")}` : "";

  const query = `
    SELECT * FROM (
      SELECT
        'log' AS kind,
        toString(Timestamp) AS ts,
        ServiceName AS service,
        substring(Body, 1, 400) AS message,
        coalesce(LogAttributes['exception.type'], '') AS exception_type,
        mapConcat(ResourceAttributes, LogAttributes) AS attrs
      FROM otel_logs
      WHERE ResourceAttributes['superlog.project_id'] = {projectId:String}
        AND Timestamp >= ${sinceExpr}
        AND Timestamp <= ${untilExpr}
        AND SeverityNumber >= 17
        ${logFilter}
      ORDER BY Timestamp DESC
      LIMIT {limit:UInt32}
      UNION ALL
      SELECT
        'span' AS kind,
        toString(Timestamp) AS ts,
        ServiceName AS service,
        substring(coalesce(event_attrs['exception.message'], SpanName), 1, 400) AS message,
        coalesce(event_attrs['exception.type'], '') AS exception_type,
        mapConcat(ResourceAttributes, SpanAttributes) AS attrs
      FROM otel_traces
      ARRAY JOIN Events.Name AS event_name, Events.Attributes AS event_attrs
      WHERE ResourceAttributes['superlog.project_id'] = {projectId:String}
        AND Timestamp >= ${sinceExpr}
        AND Timestamp <= ${untilExpr}
        AND event_name = 'exception'
        ${spanFilter}
      ORDER BY Timestamp DESC
      LIMIT {limit:UInt32}
    )
    ORDER BY ts DESC
    LIMIT {limit:UInt32}
  `;
  const r = await ch.query({ query, query_params: params, format: "JSONEachRow" });
  const rows = (await r.json()) as Array<{
    kind: "log" | "span";
    ts: string;
    service: string;
    message: string;
    exception_type: string;
    attrs: Record<string, string>;
  }>;
  return rows;
}
