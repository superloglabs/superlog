-- Arrival-ordered issue-discovery read model.
--
-- otel_exceptions preserves the telemetry event's original Timestamp, which is
-- correct for incident chronology and analytics but unsafe as a durable worker
-- cursor: an exporter can deliver an older event after the cursor has already
-- passed its event time. This projection records when each exception reaches
-- ClickHouse as discovered_at. The worker advances on discovered_at while still
-- using Timestamp for first_seen, last_seen, and issue samples.
--
-- The materialized view cascades from the existing narrow exception projection,
-- so it does not repeat the raw trace ARRAY JOIN or full log filtering work. It
-- intentionally has no historical backfill: existing worker cursors already
-- describe the processed history, and only rows arriving after this view is
-- created need the new ordering key.

CREATE TABLE IF NOT EXISTS superlog.otel_issue_candidates ON CLUSTER superlog_ha
(
    `discovered_at` DateTime64(3, 'UTC') CODEC(Delta(8), ZSTD(1)),
    `candidate_id` UUID CODEC(ZSTD(1)),
    `project_id` String CODEC(ZSTD(1)),
    `Timestamp` DateTime64(9) CODEC(Delta(8), ZSTD(1)),
    `kind` LowCardinality(String) CODEC(ZSTD(1)),
    `service` LowCardinality(String) CODEC(ZSTD(1)),
    `span_name` LowCardinality(String) CODEC(ZSTD(1)),
    `trace_id` String CODEC(ZSTD(1)),
    `span_id` String CODEC(ZSTD(1)),
    `exception_type` LowCardinality(String) CODEC(ZSTD(1)),
    `exception_message` String CODEC(ZSTD(1)),
    `exception_stacktrace` String CODEC(ZSTD(1)),
    `fingerprint` String CODEC(ZSTD(1)),
    `user_id` String CODEC(ZSTD(1)),
    `resource_attrs` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `attrs` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `body` String CODEC(ZSTD(1)),
    `severity` LowCardinality(String) CODEC(ZSTD(1)),
    `severity_number` UInt8 CODEC(ZSTD(1)),
    INDEX idx_candidate_project_id project_id TYPE set(0) GRANULARITY 4
)
ENGINE = ReplicatedMergeTree('/clickhouse/{cluster}/tables/{shard}/{database}/{table}', '{replica}')
PARTITION BY toDate(discovered_at)
ORDER BY (kind, discovered_at, candidate_id)
SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1
;

CREATE MATERIALIZED VIEW IF NOT EXISTS superlog.otel_issue_candidates_from_exceptions_mv ON CLUSTER superlog_ha
TO superlog.otel_issue_candidates
AS SELECT
    now64(3, 'UTC') AS discovered_at,
    generateUUIDv4() AS candidate_id,
    project_id,
    Timestamp,
    kind,
    service,
    span_name,
    trace_id,
    span_id,
    exception_type,
    exception_message,
    exception_stacktrace,
    fingerprint,
    user_id,
    resource_attrs,
    attrs,
    body,
    severity,
    severity_number
FROM superlog.otel_exceptions
;
