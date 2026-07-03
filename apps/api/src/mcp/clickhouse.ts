import type { ClickHouseClient } from "@clickhouse/client";

export type TimeRange = { since?: string; until?: string };
export type ResourceAttrFilter = {
  key: string;
  value: string;
  op?: "eq" | "neq" | "not_contains";
};

type AttributeColumn = "ResourceAttributes" | "SpanAttributes" | "LogAttributes";
// `field` is not an attribute map — it routes a `field.<name>` filter key to a
// top-level column (TraceId, SpanId, SeverityNumber) via the fieldColumnExpr
// allowlist below, so the explore UI can filter on identifiers, not just attrs.
type AttributeScope = "resource" | "span" | "log" | "field";
type ParsedAttributeKey = { scope: AttributeScope; key: string };

export type FieldFilterSource = "logs" | "traces";

// Allowlist mapping a `field.<name>` filter key to the ClickHouse column
// expression it compares against (as a String). Returns null for anything not
// on the list so an arbitrary `field.*` key can never reach the query — the
// value is always bound as a parameter, the column expression never is.
export function fieldColumnExpr(field: string, source: FieldFilterSource): string | null {
  switch (field) {
    case "trace_id":
      return "TraceId";
    case "span_id":
      return "SpanId";
    case "severity_number":
      // SeverityNumber only exists on logs; cast so the String param compares.
      return source === "logs" ? "toString(SeverityNumber)" : null;
    default:
      return null;
  }
}

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
    // service.name lives in the dedicated ServiceName column, which leads
    // every otel table's primary key — filter it natively so ClickHouse can
    // prune to the service's PK range instead of scanning the resource map
    // for the whole window. (The collector populates ServiceName from the
    // service.name resource attribute, so the two are equivalent.)
    const native = column === "ResourceAttributes" && a.key === "service.name";
    const target = native ? "ServiceName" : `${column}[{${kName}:String}]`;
    if (a.op === "neq") {
      conds.push(`${target} != {${vName}:String}`);
    } else if (a.op === "not_contains") {
      conds.push(`positionCaseInsensitive(${target}, {${vName}:String}) = 0`);
    } else {
      conds.push(`${target} = {${vName}:String}`);
    }
    if (!native) params[kName] = a.key;
    params[vName] = a.value;
  });
  return { conds, params };
}

function parseAttributeKey(key: string): ParsedAttributeKey {
  if (key.startsWith("resource.")) return { scope: "resource", key: key.slice("resource.".length) };
  if (key.startsWith("span.")) return { scope: "span", key: key.slice("span.".length) };
  if (key.startsWith("log.")) return { scope: "log", key: key.slice("log.".length) };
  if (key.startsWith("field.")) return { scope: "field", key: key.slice("field.".length) };
  return { scope: "resource", key };
}

function splitAttrs(
  attrs: ResourceAttrFilter[] | undefined,
): Record<AttributeScope, ResourceAttrFilter[]> {
  const out: Record<AttributeScope, ResourceAttrFilter[]> = {
    resource: [],
    span: [],
    log: [],
    field: [],
  };
  for (const attr of attrs ?? []) {
    const parsed = parseAttributeKey(attr.key);
    out[parsed.scope].push({ ...attr, key: parsed.key });
  }
  return out;
}

// Build equality conditions for `field.*` filters against top-level columns.
// Only keys on the fieldColumnExpr allowlist for this source produce a
// condition; everything else is silently dropped. Op is ignored — identifier
// filters are equality-only.
function fieldConds(
  attrs: ResourceAttrFilter[],
  source: FieldFilterSource,
  paramPrefix = "fattr",
): { conds: string[]; params: Record<string, string> } {
  const conds: string[] = [];
  const params: Record<string, string> = {};
  attrs.forEach((a, i) => {
    const expr = fieldColumnExpr(a.key, source);
    if (!expr) return;
    const vName = `${paramPrefix}_v_${i}`;
    conds.push(`${expr} = {${vName}:String}`);
    params[vName] = a.value;
  });
  return { conds, params };
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
  const field = fieldConds(split.field, "logs");
  const conds: string[] = [
    "ResourceAttributes['superlog.project_id'] = {projectId:String}",
    `Timestamp >= ${sinceExpr}`,
    `Timestamp <= ${untilExpr}`,
    // otel_logs is partitioned by toDate(TimestampTime) and sorted by
    // (ServiceName, TimestampTime, Timestamp). Filtering only Timestamp — a
    // different column — gives ClickHouse nothing to prune partitions by, so it
    // scans every retained day (incident 2026-06-25: ~12M rows for a 1h window).
    // Bracketing TimestampTime by the same window lets the partition minmax
    // index prune to the queried days. TimestampTime = toDateTime(Timestamp) is
    // truncated down to the second, so pad the lower bound by 1s to never drop a
    // sub-second row the precise Timestamp filter above keeps.
    `TimestampTime >= (${sinceExpr}) - INTERVAL 1 SECOND`,
    `TimestampTime <= ${untilExpr}`,
    ...attr.conds,
    ...logAttr.conds,
    ...field.conds,
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
      ResourceAttributes AS resource_attrs,
      LogAttributes['exception.type'] AS exception_type,
      LogAttributes['exception.message'] AS exception_message,
      LogAttributes['exception.stacktrace'] AS exception_stacktrace
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
      ...field.params,
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
  const field = fieldConds(split.field, "traces");
  const conds: string[] = [
    "ResourceAttributes['superlog.project_id'] = {projectId:String}",
    `Timestamp >= ${sinceExpr}`,
    `Timestamp <= ${untilExpr}`,
    ...attr.conds,
    ...spanAttr.conds,
    ...field.conds,
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
      ResourceAttributes AS resource_attrs,
      indexOf(Events.Name, 'exception') AS exception_event_index,
      if(exception_event_index = 0, '', Events.Attributes[exception_event_index]['exception.type']) AS exception_type,
      if(exception_event_index = 0, '', Events.Attributes[exception_event_index]['exception.message']) AS exception_message,
      if(exception_event_index = 0, '', Events.Attributes[exception_event_index]['exception.stacktrace']) AS exception_stacktrace
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
      ...field.params,
    },
    format: "JSONEachRow",
  });
  return r.json();
}

type TracesAggregatedParams = {
  range?: TimeRange;
  service?: string;
  spanName?: string;
  statusCode?: string;
  minDurationMs?: number;
  resourceAttrs?: ResourceAttrFilter[];
  limit: number;
};

// How many of the newest spans the recent-index step reverse-scans to find the
// most recently started traces. Far more than any page needs (a high-volume
// project fits thousands of traces in these spans; a small one has fewer total),
// so the true newest traces are always covered, while the bound keeps the scan a
// few granules regardless of how big the window nominally is.
const TRACE_RECENT_SCAN_CAP = 50_000;

// Step 1 (the recent index) is only a candidate generator; step 2 (the summary)
// is authoritative for which traces started in the window and for the ordering.
// Over-fetch candidates by this factor so that traces which step 1 surfaces by
// recent activity but step 2 drops (their start is before the window) don't
// shrink the page below the requested limit.
const TRACE_CANDIDATE_OVERFETCH = 5;

// The trace-summary fast path holds one aggregate-state row per trace with no
// per-span dimensions, and picks "recent" from a span-only time index — so it
// can only answer the unfiltered trace list (the default view, and the one that
// times out on the raw scan for high-volume projects). Any span-selecting filter
// — service, span name, status code, an attribute predicate — or a duration
// floor (which could exclude more traces than the recent window holds) needs the
// raw table.
function traceSummaryEligible(params: TracesAggregatedParams): boolean {
  if (params.service) return false;
  if (params.spanName) return false;
  if (params.statusCode) return false;
  if (params.minDurationMs) return false;
  if (params.resourceAttrs?.length) return false;
  return true;
}

// The materialized views only populate the derived tables from their creation
// forward; the one-shot backfill fills earlier history. Until history reaches
// back past the window start, the fast path would return a truncated list (only
// post-migration traces) where the raw scan showed the full window. Gate on the
// recent index actually holding a row older than the window start for this
// project: if it doesn't, the window isn't fully covered — fall back to the raw
// scan. This makes activation self-correcting (per project, per window) rather
// than flipping on the moment the tables exist. A brand-new project with no
// history before the window also falls back, which is fine — it is low-volume and
// the raw scan is fast there.
async function traceRollupCoversWindow(
  ch: ClickHouseClient,
  projectId: string,
  sinceExpr: string,
  sinceSql: string,
): Promise<boolean> {
  const r = await ch.query({
    query: `
      SELECT count() AS c
      FROM (
        SELECT 1
        FROM otel_traces_recent
        WHERE project_id = {projectId:String} AND ts < ${sinceExpr}
        LIMIT 1
      )
    `,
    query_params: { projectId, since: sinceSql },
    format: "JSONEachRow",
  });
  const rows = (await r.json()) as { c: string | number }[];
  return Number(rows[0]?.c ?? 0) > 0;
}

// Two-step read: (1) otel_traces_recent, a plain time-ordered span index, gives
// recent candidate trace_ids via a bounded reverse scan + GROUP BY; (2)
// otel_traces_summary filters those to traces whose start is in the window,
// supplies the displayed stats, and orders the page. Neither step scans the
// whole per-project window, so it stays ~1s where the raw GROUP BY over raw
// otel_traces is 15-60s. Output columns match the raw queryTracesAggregated query
// exactly so callers are unaffected.
//
// Semantics: the list is "traces whose start falls in [since, until]", with
// whole-trace stats (all of a trace's spans), ordered by start. For the default
// list (until = now) every included trace started at or after `since`, so all its
// spans lie in the window and the stats equal the raw window-clipped values; they
// can differ from the raw scan only for a historical window (until in the past)
// that a long trace straddles — negligible for the short traces this serves.
async function queryTracesAggregatedFromSummary(
  ch: ClickHouseClient,
  projectId: string,
  params: TracesAggregatedParams,
) {
  const { sinceSql, untilSql, sinceExpr, untilExpr } = resolveRange(params.range);
  const candidateLimit = params.limit * TRACE_CANDIDATE_OVERFETCH;
  const query = `
    WITH recent_ids AS (
      SELECT trace_id
      FROM (
        SELECT ts, trace_id
        FROM otel_traces_recent
        WHERE project_id = {projectId:String}
          AND ts >= ${sinceExpr}
          AND ts <= ${untilExpr}
        ORDER BY ts DESC
        LIMIT ${TRACE_RECENT_SCAN_CAP}
      )
      GROUP BY trace_id
      ORDER BY min(ts) DESC
      LIMIT ${candidateLimit}
    )
    SELECT
      trace_id,
      toString(min(start)) AS start_time,
      argMinMerge(root_span_name) AS root_span_name,
      argMinMerge(root_service) AS root_service,
      argMinMerge(root_status_code) AS root_status_code,
      sum(span_count) AS span_count,
      sum(error_count) AS error_count,
      uniqExactMerge(services) AS service_count,
      toFloat64(max(end_unix_nano) - min(start_unix_nano)) / 1000000 AS duration_ms
    FROM otel_traces_summary
    WHERE project_id = {projectId:String}
      AND trace_id IN (recent_ids)
      AND start >= ${sinceExpr}
      AND start <= ${untilExpr}
    GROUP BY project_id, trace_id
    ORDER BY start_time DESC
    LIMIT {limit:UInt32}
  `;
  const r = await ch.query({
    query,
    query_params: { projectId, since: sinceSql, until: untilSql, limit: params.limit },
    format: "JSONEachRow",
  });
  return r.json();
}

export async function queryTracesAggregated(
  ch: ClickHouseClient,
  projectId: string,
  params: TracesAggregatedParams,
) {
  // Fast path only when it is both available and complete for this window: both
  // derived tables exist (either missing — local dev, or before the migration
  // lands — falls back), and the recent index reaches back past the window start
  // (otherwise the list would be silently truncated to post-migration data).
  if (
    traceSummaryEligible(params) &&
    (await tableExists(ch, "otel_traces_recent")) &&
    (await tableExists(ch, "otel_traces_summary"))
  ) {
    const { sinceExpr, sinceSql } = resolveRange(params.range);
    if (await traceRollupCoversWindow(ch, projectId, sinceExpr, sinceSql)) {
      return queryTracesAggregatedFromSummary(ch, projectId, params);
    }
  }
  const { sinceSql, untilSql, sinceExpr, untilExpr } = resolveRange(params.range);
  const split = splitAttrs(params.resourceAttrs);
  const attr = attrConds(split.resource);
  const spanAttr = attrConds(split.span, "SpanAttributes", "sattr");
  const field = fieldConds(split.field, "traces");
  // Outer scope: trace-level. We aggregate over every span of every matching
  // trace in the window so span_count / duration_ms / error_count describe the
  // whole trace rather than only the spans matching span-level filters.
  const outerConds: string[] = [
    "ResourceAttributes['superlog.project_id'] = {projectId:String}",
    `Timestamp >= ${sinceExpr}`,
    `Timestamp <= ${untilExpr}`,
    ...attr.conds,
  ];
  // Inner scope: span-level filters pick which TraceIds qualify. Identifier
  // (field.*) filters like span_id are span-level too.
  const innerConds: string[] = [...outerConds, ...spanAttr.conds, ...field.conds];
  if (params.service) innerConds.push("ServiceName = {service:String}");
  if (params.spanName) innerConds.push("SpanName = {spanName:String}");
  if (params.statusCode) innerConds.push("StatusCode = {statusCode:String}");
  const hasSpanLevelFilter = !!(
    params.service ||
    params.spanName ||
    params.statusCode ||
    spanAttr.conds.length ||
    field.conds.length
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
      ...field.params,
    },
    format: "JSONEachRow",
  });
  return r.json();
}

export async function getTraceDetail(ch: ClickHouseClient, projectId: string, traceId: string) {
  // otel_traces / otel_logs are partitioned by day and sorted by
  // (ServiceName, SpanName, Timestamp), so a bare `TraceId = …` predicate can't
  // use the primary index — it scans every partition (all retained days, every
  // part). That's a multi-second-to-minutes full scan on a busy table, and a
  // burst of trace-detail loads saturates the read pool and starves every other
  // query (incident 2026-06-25: this was the lever that took prod reads down).
  // otel_traces_trace_id_ts is sorted by TraceId, so it resolves the trace's
  // [Start, End] window in O(log n); bounding Timestamp by it prunes the scan to
  // the 1–2 daily partitions the trace actually lives in.
  //
  // Fallback when the index has no row for this trace: scan the FULL retained
  // range (epoch → now), i.e. the old slow-but-correct full scan. A missing row
  // is not necessarily a just-ingested trace — it can be an older trace whose
  // index entry was never written (MV gap, or a span pre-dating the view) — so a
  // "recent" fallback window would silently return an empty trace for real data.
  // Correctness wins here; the table TTL already caps how far back the scan can
  // go, and the common case (row present — the MV writes it on insert) stays
  // tightly bounded and fast.
  const winStart = `coalesce(
              (SELECT min(Start) FROM otel_traces_trace_id_ts WHERE TraceId = {traceId:String}),
              toDateTime(0)
            ) - INTERVAL 1 MINUTE`;
  const winEnd = `coalesce(
              (SELECT max(End) FROM otel_traces_trace_id_ts WHERE TraceId = {traceId:String}),
              now()
            ) + INTERVAL 1 MINUTE`;
  // otel_traces is partitioned by toDate(Timestamp), so a Timestamp window prunes it.
  const traceWindow = `
        AND Timestamp >= ${winStart}
        AND Timestamp <= ${winEnd}`;
  // otel_logs is partitioned by toDate(TimestampTime), so it needs the window on
  // TimestampTime too (the 1-minute margins above already cover the sub-second
  // truncation, so no extra padding is needed here). Without this the logs leg
  // of the trace view scans every retained day.
  const logWindow = `${traceWindow}
        AND TimestampTime >= ${winStart}
        AND TimestampTime <= ${winEnd}`;

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
        ResourceAttributes AS resource_attrs,
        indexOf(Events.Name, 'exception') AS exception_event_index,
        if(exception_event_index = 0, '', Events.Attributes[exception_event_index]['exception.type']) AS exception_type,
        if(exception_event_index = 0, '', Events.Attributes[exception_event_index]['exception.message']) AS exception_message,
        if(exception_event_index = 0, '', Events.Attributes[exception_event_index]['exception.stacktrace']) AS exception_stacktrace
      FROM otel_traces
      WHERE ResourceAttributes['superlog.project_id'] = {projectId:String}
        AND TraceId = {traceId:String}${traceWindow}
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
        LogAttributes AS log_attrs,
        ResourceAttributes AS resource_attrs,
        LogAttributes['exception.type'] AS exception_type,
        LogAttributes['exception.message'] AS exception_message,
        LogAttributes['exception.stacktrace'] AS exception_stacktrace
      FROM otel_logs
      WHERE ResourceAttributes['superlog.project_id'] = {projectId:String}
        AND TraceId = {traceId:String}${logWindow}
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

// Discovering which attribute keys exist only needs a representative sample of
// rows, not every row in the window. High-volume projects produce millions of
// spans/logs per hour, and reading the full ResourceAttributes/SpanAttributes
// map columns across all of them took 15-30s — past the 10s ClickHouse
// request_timeout — so the explore filter dropdown 500'd. Capping the rows each
// scan reads before the arrayJoin/group keeps the query ~1s while still
// surfacing effectively every key: ClickHouse reads parts in parallel, so the
// cap samples across the window rather than just the head. Counts become
// approximate, which is fine for ordering the dropdown. Low-volume projects read
// fewer rows than the cap and stay exact.
const ATTRIBUTE_KEY_SCAN_ROW_CAP = 1_000_000;

export async function listAttributeKeys(
  ch: ClickHouseClient,
  projectId: string,
  range?: TimeRange,
  source?: SeriesSource | "metrics",
): Promise<{ key: string; count: number }[]> {
  const { sinceSql, untilSql, sinceExpr, untilExpr } = resolveRange(range);
  const resourceFromLogs = source === undefined || source === "logs" || source === "metrics";
  const resourceFromTraces = source === undefined || source === "traces" || source === "metrics";
  // Reads at most ATTRIBUTE_KEY_SCAN_ROW_CAP rows from `table`, then expands the
  // chosen map column's keys. `prefix` namespaces keys by scope (resource./span./log.);
  // pass "" to emit the bare key (the unscoped `source === undefined` case).
  const keyScan = (table: string, column: string, prefix: string): string => {
    const keyExpr = prefix ? `concat('${prefix}', k)` : "k";
    return `
      SELECT ${keyExpr} AS k, count() AS c FROM (
        SELECT mapKeys(${column}) AS mk
        FROM ${table}
        WHERE ResourceAttributes['superlog.project_id'] = {projectId:String}
          AND Timestamp >= ${sinceExpr}
          AND Timestamp <= ${untilExpr}
        LIMIT ${ATTRIBUTE_KEY_SCAN_ROW_CAP}
      ) ARRAY JOIN mk AS k
      GROUP BY k`;
  };
  const subqueries: string[] = [];
  if (source === undefined) {
    subqueries.push(keyScan("otel_logs", "ResourceAttributes", ""));
    subqueries.push(keyScan("otel_traces", "ResourceAttributes", ""));
  } else {
    if (resourceFromLogs) {
      subqueries.push(keyScan("otel_logs", "ResourceAttributes", "resource."));
    }
    if (source === "logs") {
      subqueries.push(keyScan("otel_logs", "LogAttributes", "log."));
    }
    if (resourceFromTraces) {
      subqueries.push(keyScan("otel_traces", "ResourceAttributes", "resource."));
    }
    if (source === "traces") {
      subqueries.push(keyScan("otel_traces", "SpanAttributes", "span."));
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

// Cumulative monotonic counters (OTel temporality=2, IsMonotonic) report a
// running total per series. To chart them we need the *increase* per render
// bucket. The naive approach — diff consecutive samples and drop each diff into
// the single bucket the later sample lands in — produces a "comb" whenever the
// render step is finer than the export interval: every bucket without a sample
// renders as zero, so a 60s-exported counter drawn at a 30s step alternates
// full/empty bars that read as two interleaved series.
//
// Instead we spread each sample's increase across the wall-clock interval it
// actually covers (previous sample -> this sample), à la Prometheus rate(),
// weighting by how much each render bucket overlaps that interval. A 60s
// increase straddling two 30s buckets contributes ~half to each, so the series
// is continuous. The spread is conservative: the weights for one interval sum
// to its full duration, so the total increase over the range is unchanged —
// only its distribution across buckets is smoothed. When the step is coarser
// than the export interval the whole interval lands in one bucket and this
// collapses back to the plain per-bucket delta.
function cumulativeMonotonicSumQuery(args: {
  table: string;
  step: Step;
  groupExpr: string;
  conds: string[];
  sinceExpr: string;
}): string {
  const { table, step, groupExpr, conds, sinceExpr } = args;
  const where = conds.join(" AND ");
  // Bucket arithmetic is done in nanoseconds (TimeUnix is DateTime64) so that
  // sub-second sample intervals aren't quantized away — truncating to whole
  // seconds can collapse a short interval to zero duration and silently drop
  // its increase.
  const stepNs = stepSeconds(step) * 1_000_000_000;
  return `
    SELECT
      bucket,
      group_key,
      sum(v) AS v
    FROM (
      SELECT
        toString(toStartOfInterval(toDateTime(intDiv(sp.1, 1000000000)), INTERVAL ${step.n} ${step.unit})) AS bucket,
        group_key,
        sp.2 AS v
      FROM (
        SELECT
          group_key,
          if(
            previous_value IS NULL,
            -- First sample of a series: no interval to spread over. Only count
            -- it when the series started inside the window, dropped into the
            -- bucket the sample lands in.
            [ tuple(intDiv(b, ${stepNs}) * ${stepNs}, if(StartTimeUnix >= ${sinceExpr}, Value, 0)) ],
            -- Spread the increase across every step-aligned bucket the interval
            -- (a, b] touches, weighted by overlap nanos / interval nanos.
            arrayMap(
              g -> tuple(g, delta * (least(b, g + ${stepNs}) - greatest(a, g)) / dt),
              arrayMap(
                i -> first_bucket + i * ${stepNs},
                range(toUInt32(intDiv(intDiv(b - 1, ${stepNs}) * ${stepNs} - first_bucket, ${stepNs}) + 1))
              )
            )
          ) AS spread
        FROM (
          SELECT
            group_key,
            StartTimeUnix,
            Value,
            previous_value,
            if(Value >= previous_value, Value - previous_value, 0) AS delta,
            toUnixTimestamp64Nano(prev_time) AS a,
            toUnixTimestamp64Nano(TimeUnix) AS b,
            greatest(toUnixTimestamp64Nano(TimeUnix) - toUnixTimestamp64Nano(prev_time), 1) AS dt,
            intDiv(toUnixTimestamp64Nano(prev_time), ${stepNs}) * ${stepNs} AS first_bucket
          FROM (
            SELECT
              TimeUnix,
              StartTimeUnix,
              Value,
              ${groupExpr} AS group_key,
              lagInFrame(toNullable(Value), 1, NULL) OVER series AS previous_value,
              lagInFrame(TimeUnix, 1, TimeUnix) OVER series AS prev_time
            FROM ${table}
            WHERE ${where}
              AND AggregationTemporality = 2
              AND IsMonotonic
            WINDOW series AS (
              PARTITION BY cityHash64(
                ServiceName,
                MetricName,
                MetricUnit,
                toString(ResourceAttributes),
                toString(Attributes),
                toString(StartTimeUnix)
              )
              ORDER BY TimeUnix ASC
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            )
          )
        )
      )
      ARRAY JOIN spread AS sp

      UNION ALL

      SELECT
        toString(toStartOfInterval(TimeUnix, INTERVAL ${step.n} ${step.unit})) AS bucket,
        ${groupExpr} AS group_key,
        Value AS v
      FROM ${table}
      WHERE ${where}
        AND NOT (AggregationTemporality = 2 AND IsMonotonic)
    )
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
        : kind === "sum" && (!aggregation || aggregation === "sum")
          ? cumulativeMonotonicSumQuery({
              table,
              step,
              groupExpr,
              conds,
              sinceExpr,
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

// -----------------------------------------------------------------------------
// events_per_minute rollup fast path. Count widgets over long ranges were
// scanning the raw tables (and the ResourceAttributes map) for every row in
// the window, which times out for high-volume projects. Queries the rollup
// (see infra/clickhouse/migrations/003_events_per_minute.sql) can answer —
// minute-or-coarser buckets, filters within (service, severity, status_code),
// grouping by nothing or service — read it instead.
//
// Availability is probed once per client and memoized so deployments without
// the rollup (it is not part of the collector's auto-created schema) fall
// back to the raw scan without a per-request penalty.
// -----------------------------------------------------------------------------

const tableExistsMemo = new WeakMap<ClickHouseClient, Map<string, Promise<boolean>>>();

// `EXISTS TABLE <name>` probe, per client + table. Derived tables
// (events_per_minute, otel_traces_summary, …) are not part of the collector's
// auto-created schema, so deployments without them must fall back to the raw
// scan without a per-request penalty. `table` is always a hardcoded literal
// here — never interpolate user input into this.
//
// Only a positive result is cached (a table won't disappear from under a
// running process). A negative or errored probe is NOT cached: it's evicted once
// it resolves so the next call re-probes. This matters because these tables are
// created by a manual migration that can land AFTER the app boots — caching
// "absent" forever would pin the process to the raw scan until it restarts, even
// though the fast path became available. The probe is a cheap metadata lookup,
// and concurrent callers still share the one in-flight promise.
function tableExists(ch: ClickHouseClient, table: string): Promise<boolean> {
  let byTable = tableExistsMemo.get(ch);
  if (!byTable) {
    byTable = new Map();
    tableExistsMemo.set(ch, byTable);
  }
  const cached = byTable.get(table);
  if (cached) return cached;
  const probe = (async () => {
    try {
      const r = await ch.query({ query: `EXISTS TABLE ${table}`, format: "JSONEachRow" });
      const rows = (await r.json()) as { result: number | string }[];
      return Number(rows[0]?.result) === 1;
    } catch {
      return false;
    }
  })();
  byTable.set(table, probe);
  // Keep only a cached `true`; drop `false`/errored probes so a later call
  // re-checks (self-heals once the migration lands).
  probe
    .then((exists) => {
      if (!exists) byTable?.delete(table);
    })
    .catch(() => byTable?.delete(table));
  return probe;
}

function rollupAvailable(ch: ClickHouseClient): Promise<boolean> {
  return tableExists(ch, "events_per_minute");
}

// A widget that filters on the service.name resource attribute (instead of
// the dedicated service field) is still asking a service question — fold a
// lone equality into `service` so the rollup can answer it. Returns null
// when the filter isn't foldable.
function foldServiceAttrFilter(filter: SeriesFilter): SeriesFilter | null {
  const attrs = filter.resourceAttrs ?? [];
  if (attrs.length === 0) return filter;
  if (attrs.length !== 1 || filter.service) return null;
  const attr = attrs[0];
  if (!attr || (attr.op && attr.op !== "eq")) return null;
  const parsed = parseAttributeKey(attr.key);
  if (parsed.scope !== "resource" || parsed.key !== "service.name") return null;
  return { ...filter, service: attr.value, resourceAttrs: [] };
}

function rollupEligible(filter: SeriesFilter, groupBy: string | undefined, step: Step): boolean {
  if (step.unit === "SECOND") return false; // rollup resolution is one minute
  if (filter.resourceAttrs?.length) return false;
  if (filter.search) return false;
  if (filter.spanName) return false;
  if (filter.minDurationMs) return false;
  if (groupBy && groupBy !== "service" && groupBy !== "service.name") return false;
  return true;
}

async function countSeriesFromRollup(
  ch: ClickHouseClient,
  projectId: string,
  source: SeriesSource,
  filter: SeriesFilter,
  groupBy: string | undefined,
  step: Step,
): Promise<{ bucket: string; group: string; count: number }[]> {
  const { sinceSql, untilSql, sinceExpr, untilExpr } = resolveRange(filter.range);
  const conds = [
    "project_id = {projectId:String}",
    "signal = {signal:String}",
    // Rollup cells are whole minutes, so a sub-minute `since` cannot be
    // honored exactly. Round the lower bound down to the cell boundary so the
    // partial first minute is included in full rather than dropped — edge
    // buckets may overcount by up to one minute of data, never undercount.
    // (The upper bound needs no rounding: the cell at until's minute starts
    // at or before `until` and already satisfies <=.) The fast path only
    // serves >= 1-minute chart buckets, so the skew stays within one bucket.
    `minute >= toStartOfMinute(${sinceExpr})`,
    `minute <= ${untilExpr}`,
  ];
  if (filter.service) conds.push("service = {service:String}");
  if (source === "logs") {
    // The rollup stores upper(SeverityText); mirror the raw path's
    // case-insensitive comparison.
    if (filter.severity) conds.push("severity = upper({severity:String})");
  } else if (filter.statusCode) {
    conds.push("status_code = {statusCode:String}");
  }
  const groupExpr = groupBy ? "service" : "''";

  const query = `
    SELECT
      toString(toStartOfInterval(minute, INTERVAL ${step.n} ${step.unit})) AS bucket,
      ${groupExpr} AS group_key,
      sum(c) AS c
    FROM events_per_minute
    WHERE ${conds.join(" AND ")}
    GROUP BY bucket, group_key
    ORDER BY bucket ASC
    LIMIT 10000
  `;

  const r = await ch.query({
    query,
    query_params: {
      projectId,
      signal: source,
      since: sinceSql,
      until: untilSql,
      service: filter.service ?? "",
      severity: filter.severity ?? "",
      statusCode: filter.statusCode ?? "",
    },
    format: "JSONEachRow",
  });
  const rows = (await r.json()) as { bucket: string; group_key: string; c: string | number }[];
  return rows.map((row) => ({ bucket: row.bucket, group: row.group_key, count: Number(row.c) }));
}

export async function countSeries(
  ch: ClickHouseClient,
  projectId: string,
  source: SeriesSource,
  filter: SeriesFilter,
  groupBy: string | undefined,
  step: Step,
): Promise<{ bucket: string; group: string; count: number }[]> {
  const folded = foldServiceAttrFilter(filter);
  if (folded && rollupEligible(folded, groupBy, step) && (await rollupAvailable(ch))) {
    return countSeriesFromRollup(ch, projectId, source, folded, groupBy, step);
  }
  const { sinceSql, untilSql, sinceExpr, untilExpr } = resolveRange(filter.range);
  const split = splitAttrs(filter.resourceAttrs);
  const attr = attrConds(split.resource);
  const eventAttr =
    source === "logs"
      ? attrConds(split.log, "LogAttributes", "event_attr")
      : attrConds(split.span, "SpanAttributes", "event_attr");
  const field = fieldConds(split.field, source === "logs" ? "logs" : "traces");
  const table = source === "logs" ? "otel_logs" : "otel_traces";
  const conds: string[] = [
    "ResourceAttributes['superlog.project_id'] = {projectId:String}",
    `Timestamp >= ${sinceExpr}`,
    `Timestamp <= ${untilExpr}`,
    ...attr.conds,
    ...eventAttr.conds,
    ...field.conds,
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
      ...field.params,
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
