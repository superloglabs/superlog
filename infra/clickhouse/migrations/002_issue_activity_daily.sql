-- Pre-aggregated incident recurrence counts keyed by the same issue fingerprint
-- the worker stores in Postgres. New telemetry rows are fed by materialized
-- views from the `superlog.issue_fingerprint` attribute stamped at ingest.
--
-- Historical rows ingested before that attribute existed need the companion
-- backfill script in `apps/worker/scripts/backfill-issue-activity-daily.ts`.

CREATE TABLE IF NOT EXISTS superlog.issue_activity_daily ON CLUSTER superlog_ha
(
    `project_id` String CODEC(ZSTD(1)),
    `fingerprint` String CODEC(ZSTD(1)),
    `day` Date CODEC(Delta(2), ZSTD(1)),
    `event_count` UInt64 CODEC(Delta(8), ZSTD(1))
)
ENGINE = ReplicatedSummingMergeTree('/clickhouse/{cluster}/tables/{shard}/{database}/{table}', '{replica}')
PARTITION BY toYYYYMM(day)
ORDER BY (project_id, fingerprint, day)
SETTINGS index_granularity = 8192
;

CREATE MATERIALIZED VIEW IF NOT EXISTS superlog.issue_activity_daily_from_traces_mv ON CLUSTER superlog_ha
TO superlog.issue_activity_daily
AS SELECT
    ResourceAttributes['superlog.project_id'] AS project_id,
    event_attrs['superlog.issue_fingerprint'] AS fingerprint,
    toDate(Timestamp) AS day,
    count() AS event_count
FROM superlog.otel_traces
ARRAY JOIN Events.Name AS event_name, Events.Attributes AS event_attrs
WHERE event_name = 'exception'
  AND ResourceAttributes['superlog.project_id'] != ''
  AND event_attrs['superlog.issue_fingerprint'] != ''
GROUP BY project_id, fingerprint, day
;

CREATE MATERIALIZED VIEW IF NOT EXISTS superlog.issue_activity_daily_from_logs_mv ON CLUSTER superlog_ha
TO superlog.issue_activity_daily
AS SELECT
    ResourceAttributes['superlog.project_id'] AS project_id,
    LogAttributes['superlog.issue_fingerprint'] AS fingerprint,
    toDate(TimestampTime) AS day,
    count() AS event_count
FROM superlog.otel_logs
WHERE SeverityNumber >= 17
  AND ResourceAttributes['superlog.project_id'] != ''
  AND LogAttributes['superlog.issue_fingerprint'] != ''
GROUP BY project_id, fingerprint, day
;
