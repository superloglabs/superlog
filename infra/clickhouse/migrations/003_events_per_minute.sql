-- Per-minute event counts per project, feeding the dashboard / explore
-- timeseries-count fast path (countSeries in apps/api/src/mcp/clickhouse.ts).
--
-- Why: count widgets bucket raw otel_traces / otel_logs rows by time, which
-- forces a scan of every row in the window (including the ResourceAttributes
-- map for the project filter). For high-volume projects a 24h+ range reads
-- hundreds of millions of rows and exceeds the API's ClickHouse timeout.
-- A SummingMergeTree keyed (project, signal, service, severity, status_code,
-- minute) answers the same charts in milliseconds at any range.
--
-- Dimensions cover what the chart UI can filter / group on without attribute
-- predicates: service, log severity (stored uppercased to keep the raw
-- path's case-insensitive match), trace status code. Queries with attribute
-- filters, body search, span-name / duration predicates, or sub-minute
-- buckets keep scanning the raw tables.
--
-- Run ONCE per environment. Statements are IF NOT EXISTS so they are
-- individually safe to retry. The MVs only roll up rows inserted AFTER they
-- are created; historical charts need a one-shot backfill, chunked by day to
-- bound memory, covering only time strictly BEFORE the MV creation minute so
-- nothing is double-counted, e.g.:
--
--   INSERT INTO superlog.events_per_minute
--   SELECT ResourceAttributes['superlog.project_id'], 'traces', ServiceName,
--          '', toString(StatusCode), toStartOfMinute(Timestamp), count()
--   FROM superlog.otel_traces
--   WHERE Timestamp >= {day} AND Timestamp < {day_after}
--     AND Timestamp < {mv_created_minute}
--     AND ResourceAttributes['superlog.project_id'] != ''
--   GROUP BY 1, 2, 3, 4, 5, 6;
--
-- (and the analogous SELECT from otel_logs with upper(SeverityText) /
-- TimestampTime).

CREATE TABLE IF NOT EXISTS superlog.events_per_minute ON CLUSTER superlog_ha
(
    `project_id` String CODEC(ZSTD(1)),
    `signal` LowCardinality(String) CODEC(ZSTD(1)),
    `service` LowCardinality(String) CODEC(ZSTD(1)),
    `severity` LowCardinality(String) CODEC(ZSTD(1)),
    `status_code` LowCardinality(String) CODEC(ZSTD(1)),
    `minute` DateTime CODEC(Delta(4), ZSTD(1)),
    `c` UInt64 CODEC(Delta(8), ZSTD(1))
)
ENGINE = ReplicatedSummingMergeTree('/clickhouse/{cluster}/tables/{shard}/{database}/{table}', '{replica}')
PARTITION BY toYYYYMM(minute)
ORDER BY (project_id, signal, service, severity, status_code, minute)
SETTINGS index_granularity = 8192
;

CREATE MATERIALIZED VIEW IF NOT EXISTS superlog.events_per_minute_from_traces_mv ON CLUSTER superlog_ha TO superlog.events_per_minute
AS SELECT
    ResourceAttributes['superlog.project_id'] AS project_id,
    'traces' AS signal,
    ServiceName AS service,
    '' AS severity,
    toString(StatusCode) AS status_code,
    toStartOfMinute(Timestamp) AS minute,
    count() AS c
FROM superlog.otel_traces
WHERE ResourceAttributes['superlog.project_id'] != ''
GROUP BY project_id, signal, service, severity, status_code, minute
;

CREATE MATERIALIZED VIEW IF NOT EXISTS superlog.events_per_minute_from_logs_mv ON CLUSTER superlog_ha TO superlog.events_per_minute
AS SELECT
    ResourceAttributes['superlog.project_id'] AS project_id,
    'logs' AS signal,
    ServiceName AS service,
    upper(SeverityText) AS severity,
    '' AS status_code,
    toStartOfMinute(TimestampTime) AS minute,
    count() AS c
FROM superlog.otel_logs
WHERE ResourceAttributes['superlog.project_id'] != ''
GROUP BY project_id, signal, service, severity, status_code, minute
;
