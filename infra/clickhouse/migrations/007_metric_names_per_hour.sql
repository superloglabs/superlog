-- Per-hour metric-name counts per project, feeding the metric-name picker
-- fast path (listMetricNames in apps/api/src/mcp/clickhouse.ts).
--
-- Why: the picker only needs the distinct MetricName/MetricUnit pairs in the
-- window, but the project filter on the raw otel_metrics_* tables is a
-- ResourceAttributes map lookup that no primary-key or partition pruning
-- helps with. On high-volume projects each per-table GROUP BY reads millions
-- of rows (~0.5 GiB of map column) per request, and the four tables together
-- put the picker load at 10s+. Row-capped sampling is not an option here: the
-- raw tables sort by (ServiceName, MetricName, ...), so a capped scan
-- systematically drops metrics late in the sort order — a picker that hides
-- metrics is broken for discovery. A SummingMergeTree keyed
-- (project, kind, name, unit, hour) answers the same query exactly, in
-- milliseconds at any range.
--
-- The `kind` column carries which raw table the name came from
-- (gauge | sum | histogram | summary) since the picker needs it to route
-- subsequent series queries. Counts are only used to order the picker by
-- frequency. otel_metrics_exp_histogram is intentionally not rolled up — the
-- API does not read it.
--
-- Run ONCE per environment. Statements are IF NOT EXISTS so they are
-- individually safe to retry. The MVs only roll up rows inserted AFTER they
-- are created; historical windows need a one-shot backfill, chunked by day to
-- bound memory, covering only time strictly BEFORE the MV creation hour so
-- nothing is double-counted, e.g. (once per metric table/kind):
--
--   INSERT INTO superlog.metric_names_per_hour
--   SELECT ResourceAttributes['superlog.project_id'], 'gauge', MetricName,
--          MetricUnit, toStartOfHour(TimeUnix), count()
--   FROM superlog.otel_metrics_gauge
--   WHERE TimeUnix >= {day} AND TimeUnix < {day_after}
--     AND TimeUnix < {mv_created_hour}
--     AND ResourceAttributes['superlog.project_id'] != ''
--   GROUP BY 1, 2, 3, 4, 5;
--
-- The read path gates on the rollup reaching back past the window start for
-- the project (see metricNamesRollupCoversWindow) and falls back to the raw
-- scan otherwise, so applying this before the backfill never under-reports.

CREATE TABLE IF NOT EXISTS superlog.metric_names_per_hour ON CLUSTER superlog_ha
(
    `project_id` String CODEC(ZSTD(1)),
    `kind` LowCardinality(String) CODEC(ZSTD(1)),
    `name` String CODEC(ZSTD(1)),
    `unit` LowCardinality(String) CODEC(ZSTD(1)),
    `hour` DateTime CODEC(Delta(4), ZSTD(1)),
    `c` UInt64 CODEC(Delta(8), ZSTD(1))
)
ENGINE = ReplicatedSummingMergeTree('/clickhouse/{cluster}/tables/{shard}/{database}/{table}', '{replica}')
PARTITION BY toYYYYMM(hour)
ORDER BY (project_id, kind, name, unit, hour)
SETTINGS index_granularity = 8192
;

CREATE MATERIALIZED VIEW IF NOT EXISTS superlog.metric_names_per_hour_from_gauge_mv ON CLUSTER superlog_ha TO superlog.metric_names_per_hour
AS SELECT
    ResourceAttributes['superlog.project_id'] AS project_id,
    'gauge' AS kind,
    MetricName AS name,
    MetricUnit AS unit,
    toStartOfHour(TimeUnix) AS hour,
    count() AS c
FROM superlog.otel_metrics_gauge
WHERE ResourceAttributes['superlog.project_id'] != ''
GROUP BY project_id, kind, name, unit, hour
;

CREATE MATERIALIZED VIEW IF NOT EXISTS superlog.metric_names_per_hour_from_sum_mv ON CLUSTER superlog_ha TO superlog.metric_names_per_hour
AS SELECT
    ResourceAttributes['superlog.project_id'] AS project_id,
    'sum' AS kind,
    MetricName AS name,
    MetricUnit AS unit,
    toStartOfHour(TimeUnix) AS hour,
    count() AS c
FROM superlog.otel_metrics_sum
WHERE ResourceAttributes['superlog.project_id'] != ''
GROUP BY project_id, kind, name, unit, hour
;

CREATE MATERIALIZED VIEW IF NOT EXISTS superlog.metric_names_per_hour_from_histogram_mv ON CLUSTER superlog_ha TO superlog.metric_names_per_hour
AS SELECT
    ResourceAttributes['superlog.project_id'] AS project_id,
    'histogram' AS kind,
    MetricName AS name,
    MetricUnit AS unit,
    toStartOfHour(TimeUnix) AS hour,
    count() AS c
FROM superlog.otel_metrics_histogram
WHERE ResourceAttributes['superlog.project_id'] != ''
GROUP BY project_id, kind, name, unit, hour
;

CREATE MATERIALIZED VIEW IF NOT EXISTS superlog.metric_names_per_hour_from_summary_mv ON CLUSTER superlog_ha TO superlog.metric_names_per_hour
AS SELECT
    ResourceAttributes['superlog.project_id'] AS project_id,
    'summary' AS kind,
    MetricName AS name,
    MetricUnit AS unit,
    toStartOfHour(TimeUnix) AS hour,
    count() AS c
FROM superlog.otel_metrics_summary
WHERE ResourceAttributes['superlog.project_id'] != ''
GROUP BY project_id, kind, name, unit, hour
;
