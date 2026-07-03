-- Trace-list fast path (queryTracesAggregated in apps/api/src/mcp/clickhouse.ts —
-- the explore "traces" grouped list). Two derived tables, read in two steps.
--
-- Why: the grouped list does `GROUP BY TraceId` over every span in the selected
-- window of raw otel_traces, then sorts and limits. otel_traces is sorted by
-- (ServiceName, SpanName, Timestamp) and the project filter lives in the
-- ResourceAttributes map, so a project's list can't use the primary index — it
-- scans the whole multi-tenant window. Over a 24h range on a busy deployment
-- that reads hundreds of millions of rows and exceeds the API's ClickHouse
-- request timeout, so the list 500s while the (rollup-backed) chart above it
-- still renders.
--
-- A single per-trace rollup is NOT enough on its own: a high-volume project can
-- have millions of traces in a day, and "the 100 most recent" still means a
-- GROUP BY + sort over all of them (measured ~15s at 24h). The sort key can't be
-- the trace start either — it's a min-aggregate, and SimpleAggregateFunction
-- columns are not allowed in a key. So we split the work the way trace backends
-- (Tempo/Jaeger) do:
--
--   1. otel_traces_recent — a plain, time-ordered index of every span
--      (project_id, ts, trace_id), ORDER BY (project_id, ts). A bounded reverse
--      scan of the newest spans, grouped by trace_id, yields the N most recently
--      started trace_ids in milliseconds. Covers ALL traces (no root-span
--      dependency; ~35% of traces have no root span).
--   2. otel_traces_summary — one aggregate-state row per (project_id, trace_id)
--      with start, span/error counts, root span/service/status (earliest span by
--      Timestamp), distinct-service count, and the [start,end] nanos for total
--      duration. Looked up for just those N trace_ids (IN, indexed) to fill in
--      the displayed stats.
--
-- Net ~1s at 24h for a 7.8M-trace/day project vs 15-60s on the raw scan.
--
-- otel_traces_summary is AggregatingMergeTree (not Summing): a trace's spans
-- arrive across many inserts, so min/max/argMin/uniqExact must merge partial
-- states over time. Readers MUST re-aggregate (GROUP BY project_id, trace_id
-- with sum()/min()/max() for the SimpleAggregateFunction columns and *Merge for
-- the AggregateFunction ones) — see queryTracesAggregatedFromSummary.
--
-- No TTL clause: otel_traces itself carries none here, so bounding these derived
-- tables would under-report long-window lists relative to the source. Retention
-- should track the source table's when that is added.
--
-- Run ONCE per environment. Statements are IF NOT EXISTS so they are
-- individually safe to retry. The MVs only capture rows inserted AFTER they are
-- created; historical traces need the companion one-shot backfill script
-- apps/worker/scripts/backfill-otel-traces-summary.ts, run over
-- [retention_start, mv_cutover) so it never overlaps the live MV window (an
-- overlap re-inserts the same spans and double-counts span_count/error_count in
-- the summary, and duplicates rows in the recent index).

-- 1. Time-ordered span index -------------------------------------------------
CREATE TABLE IF NOT EXISTS superlog.otel_traces_recent ON CLUSTER superlog_ha
(
    `project_id` String CODEC(ZSTD(1)),
    `ts` DateTime64(9) CODEC(Delta(8), ZSTD(1)),
    `trace_id` String CODEC(ZSTD(1))
)
ENGINE = ReplicatedMergeTree('/clickhouse/{cluster}/tables/{shard}/{database}/{table}', '{replica}')
PARTITION BY toDate(ts)
ORDER BY (project_id, ts)
SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1
;

CREATE MATERIALIZED VIEW IF NOT EXISTS superlog.otel_traces_recent_mv ON CLUSTER superlog_ha
TO superlog.otel_traces_recent
AS SELECT
    ResourceAttributes['superlog.project_id'] AS project_id,
    Timestamp AS ts,
    TraceId AS trace_id
FROM superlog.otel_traces
WHERE ResourceAttributes['superlog.project_id'] != '' AND TraceId != ''
;

-- 2. Per-trace aggregate summary ---------------------------------------------
CREATE TABLE IF NOT EXISTS superlog.otel_traces_summary ON CLUSTER superlog_ha
(
    `project_id` String CODEC(ZSTD(1)),
    `trace_id` String CODEC(ZSTD(1)),
    `start` SimpleAggregateFunction(min, DateTime64(9)) CODEC(ZSTD(1)),
    `start_unix_nano` SimpleAggregateFunction(min, Int64) CODEC(ZSTD(1)),
    `end_unix_nano` SimpleAggregateFunction(max, Int64) CODEC(ZSTD(1)),
    `span_count` SimpleAggregateFunction(sum, UInt64) CODEC(ZSTD(1)),
    `error_count` SimpleAggregateFunction(sum, UInt64) CODEC(ZSTD(1)),
    `root_span_name` AggregateFunction(argMin, LowCardinality(String), DateTime64(9)),
    `root_service` AggregateFunction(argMin, LowCardinality(String), DateTime64(9)),
    `root_status_code` AggregateFunction(argMin, LowCardinality(String), DateTime64(9)),
    `services` AggregateFunction(uniqExact, LowCardinality(String))
)
ENGINE = ReplicatedAggregatingMergeTree('/clickhouse/{cluster}/tables/{shard}/{database}/{table}', '{replica}')
PARTITION BY toDate(start)
ORDER BY (project_id, trace_id)
SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1
;

CREATE MATERIALIZED VIEW IF NOT EXISTS superlog.otel_traces_summary_mv ON CLUSTER superlog_ha
TO superlog.otel_traces_summary
AS SELECT
    ResourceAttributes['superlog.project_id'] AS project_id,
    TraceId AS trace_id,
    min(Timestamp) AS start,
    min(toUnixTimestamp64Nano(Timestamp)) AS start_unix_nano,
    max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration)) AS end_unix_nano,
    count() AS span_count,
    countIf(StatusCode = 'STATUS_CODE_ERROR') AS error_count,
    argMinState(SpanName, Timestamp) AS root_span_name,
    argMinState(ServiceName, Timestamp) AS root_service,
    argMinState(StatusCode, Timestamp) AS root_status_code,
    uniqExactState(ServiceName) AS services
FROM superlog.otel_traces
WHERE ResourceAttributes['superlog.project_id'] != '' AND TraceId != ''
GROUP BY project_id, trace_id
;
