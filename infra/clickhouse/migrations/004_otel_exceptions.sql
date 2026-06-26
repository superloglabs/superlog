-- A narrow, exception-only projection of otel_traces + otel_logs.
--
-- The Issues/Incidents feature (incident sparklines, affected-users counts,
-- occurrences-over-time) and the worker's exception-ingest loop all find
-- exceptions by scanning the full otel_traces table with
-- `ARRAY JOIN Events ... WHERE event_name = 'exception'`. `Events` is a nested
-- column with no usable skip index, so every one of those reads expands and
-- scans *every* span's events over a multi-day window — 130M+ rows / ~90s on a
-- busy project, which periodically saturates the shared read pool (and is what
-- the end-to-end uptime monitor trips on first).
--
-- `otel_exceptions` holds one row per exception event (a tiny fraction of all
-- spans/logs), keyed so those queries become small indexed reads instead of
-- full-table ARRAY JOIN scans. New rows are fed by the two materialized views
-- below; historical rows need the companion backfill script
-- `apps/worker/scripts/backfill-otel-exceptions.ts`.
--
-- Membership mirrors the app's existing notion of an "exception" exactly, so
-- the query rewrites are behaviour-preserving:
--   * traces: an `exception` span event
--   * logs:   SeverityNumber >= 17 (ERROR+)
-- `exception_type` / `fingerprint` / `user_id` are stored verbatim (empty when
-- absent) — callers filter on them, they don't define membership.
--
-- No TTL clause: otel_traces / otel_logs themselves carry none, so bounding
-- this derived table at N days would under-report long-window queries relative
-- to the source. (A TTL can be added later alongside source-table retention.)

CREATE TABLE IF NOT EXISTS superlog.otel_exceptions ON CLUSTER superlog_ha
(
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
    -- Full attribute maps so the worker's exception-ingest loop (issue
    -- fingerprinting + issue-filtering + lastSample) can read this table rather
    -- than ARRAY JOIN-scanning otel_traces. `attrs` = SpanAttributes for spans /
    -- LogAttributes for logs; `resource_attrs` = the resource map for both.
    `resource_attrs` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `attrs` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    -- Log-only fields the worker needs for fingerprintLog + lastSample (the log
    -- "message" is its Body, not exception.message). Empty/0 for span rows.
    `body` String CODEC(ZSTD(1)),
    `severity` LowCardinality(String) CODEC(ZSTD(1)),
    `severity_number` UInt8 CODEC(ZSTD(1)),
    INDEX idx_exc_project_id project_id TYPE set(0) GRANULARITY 4
)
ENGINE = ReplicatedMergeTree('/clickhouse/{cluster}/tables/{shard}/{database}/{table}', '{replica}')
PARTITION BY toDate(Timestamp)
ORDER BY (project_id, service, exception_type, Timestamp)
SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1
;

CREATE MATERIALIZED VIEW IF NOT EXISTS superlog.otel_exceptions_from_traces_mv ON CLUSTER superlog_ha
TO superlog.otel_exceptions
AS SELECT
    ResourceAttributes['superlog.project_id'] AS project_id,
    Timestamp,
    'span' AS kind,
    ServiceName AS service,
    SpanName AS span_name,
    TraceId AS trace_id,
    SpanId AS span_id,
    event_attrs['exception.type'] AS exception_type,
    event_attrs['exception.message'] AS exception_message,
    event_attrs['exception.stacktrace'] AS exception_stacktrace,
    event_attrs['superlog.issue_fingerprint'] AS fingerprint,
    if(SpanAttributes['user.id'] != '', SpanAttributes['user.id'], ResourceAttributes['user.id']) AS user_id,
    ResourceAttributes AS resource_attrs,
    SpanAttributes AS attrs,
    '' AS body,
    '' AS severity,
    toUInt8(0) AS severity_number
FROM superlog.otel_traces
ARRAY JOIN Events.Name AS event_name, Events.Attributes AS event_attrs
WHERE event_name = 'exception'
  AND ResourceAttributes['superlog.project_id'] != ''
;

CREATE MATERIALIZED VIEW IF NOT EXISTS superlog.otel_exceptions_from_logs_mv ON CLUSTER superlog_ha
TO superlog.otel_exceptions
AS SELECT
    ResourceAttributes['superlog.project_id'] AS project_id,
    Timestamp,
    'log' AS kind,
    ServiceName AS service,
    '' AS span_name,
    TraceId AS trace_id,
    SpanId AS span_id,
    LogAttributes['exception.type'] AS exception_type,
    LogAttributes['exception.message'] AS exception_message,
    LogAttributes['exception.stacktrace'] AS exception_stacktrace,
    LogAttributes['superlog.issue_fingerprint'] AS fingerprint,
    if(LogAttributes['user.id'] != '', LogAttributes['user.id'], ResourceAttributes['user.id']) AS user_id,
    ResourceAttributes AS resource_attrs,
    LogAttributes AS attrs,
    Body AS body,
    SeverityText AS severity,
    toUInt8(SeverityNumber) AS severity_number
FROM superlog.otel_logs
WHERE SeverityNumber >= 17
  AND ResourceAttributes['superlog.project_id'] != ''
;
