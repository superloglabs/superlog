CREATE DATABASE IF NOT EXISTS superlog ON CLUSTER superlog_ha;

-- otel_traces
CREATE TABLE IF NOT EXISTS superlog.otel_traces ON CLUSTER superlog_ha
(
    `Timestamp` DateTime64(9) CODEC(Delta(8), ZSTD(1)),
    `TraceId` String CODEC(ZSTD(1)),
    `SpanId` String CODEC(ZSTD(1)),
    `ParentSpanId` String CODEC(ZSTD(1)),
    `TraceState` String CODEC(ZSTD(1)),
    `SpanName` LowCardinality(String) CODEC(ZSTD(1)),
    `SpanKind` LowCardinality(String) CODEC(ZSTD(1)),
    `ServiceName` LowCardinality(String) CODEC(ZSTD(1)),
    `ResourceAttributes` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `SuperlogProjectId` LowCardinality(String) MATERIALIZED ResourceAttributes['superlog.project_id'],
    `ScopeName` String CODEC(ZSTD(1)),
    `ScopeVersion` String CODEC(ZSTD(1)),
    `SpanAttributes` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `Duration` UInt64 CODEC(ZSTD(1)),
    `StatusCode` LowCardinality(String) CODEC(ZSTD(1)),
    `StatusMessage` String CODEC(ZSTD(1)),
    `Events.Timestamp` Array(DateTime64(9)) CODEC(ZSTD(1)),
    `Events.Name` Array(LowCardinality(String)) CODEC(ZSTD(1)),
    `Events.Attributes` Array(Map(LowCardinality(String), String)) CODEC(ZSTD(1)),
    `Links.TraceId` Array(String) CODEC(ZSTD(1)),
    `Links.SpanId` Array(String) CODEC(ZSTD(1)),
    `Links.TraceState` Array(String) CODEC(ZSTD(1)),
    `Links.Attributes` Array(Map(LowCardinality(String), String)) CODEC(ZSTD(1)),
    INDEX idx_trace_id TraceId TYPE bloom_filter(0.001) GRANULARITY 1,
    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_span_attr_key mapKeys(SpanAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_span_attr_value mapValues(SpanAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_duration Duration TYPE minmax GRANULARITY 1,
    INDEX idx_superlog_project_id_materialized SuperlogProjectId TYPE set(0) GRANULARITY 1
)
ENGINE = ReplicatedMergeTree('/clickhouse/{cluster}/tables/{shard}/{database}/{table}', '{replica}')
PARTITION BY toDate(Timestamp)
ORDER BY (ServiceName, SpanName, toDateTime(Timestamp))
SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1
;
-- otel_logs
CREATE TABLE IF NOT EXISTS superlog.otel_logs ON CLUSTER superlog_ha
(
    `Timestamp` DateTime64(9) CODEC(Delta(8), ZSTD(1)),
    `TimestampTime` DateTime DEFAULT toDateTime(Timestamp),
    `TraceId` String CODEC(ZSTD(1)),
    `SpanId` String CODEC(ZSTD(1)),
    `TraceFlags` UInt8,
    `SeverityText` LowCardinality(String) CODEC(ZSTD(1)),
    `SeverityNumber` UInt8,
    `ServiceName` LowCardinality(String) CODEC(ZSTD(1)),
    `Body` String CODEC(ZSTD(1)),
    `ResourceSchemaUrl` LowCardinality(String) CODEC(ZSTD(1)),
    `ResourceAttributes` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `SuperlogProjectId` LowCardinality(String) MATERIALIZED ResourceAttributes['superlog.project_id'],
    `ScopeSchemaUrl` LowCardinality(String) CODEC(ZSTD(1)),
    `ScopeName` String CODEC(ZSTD(1)),
    `ScopeVersion` LowCardinality(String) CODEC(ZSTD(1)),
    `ScopeAttributes` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `LogAttributes` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `EventName` String CODEC(ZSTD(1)),
    INDEX idx_trace_id TraceId TYPE bloom_filter(0.001) GRANULARITY 1,
    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_key mapKeys(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_value mapValues(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_log_attr_key mapKeys(LogAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_log_attr_value mapValues(LogAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_body Body TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 8,
    INDEX idx_superlog_project_id_materialized SuperlogProjectId TYPE set(0) GRANULARITY 1
)
ENGINE = ReplicatedMergeTree('/clickhouse/{cluster}/tables/{shard}/{database}/{table}', '{replica}')
PARTITION BY toDate(TimestampTime)
PRIMARY KEY (ServiceName, TimestampTime)
ORDER BY (ServiceName, TimestampTime, Timestamp)
SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1
;
-- otel_metrics_gauge
CREATE TABLE IF NOT EXISTS superlog.otel_metrics_gauge ON CLUSTER superlog_ha
(
    `ResourceAttributes` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `SuperlogProjectId` LowCardinality(String) MATERIALIZED ResourceAttributes['superlog.project_id'],
    `ResourceSchemaUrl` String CODEC(ZSTD(1)),
    `ScopeName` String CODEC(ZSTD(1)),
    `ScopeVersion` String CODEC(ZSTD(1)),
    `ScopeAttributes` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `ScopeDroppedAttrCount` UInt32 CODEC(ZSTD(1)),
    `ScopeSchemaUrl` String CODEC(ZSTD(1)),
    `ServiceName` LowCardinality(String) CODEC(ZSTD(1)),
    `MetricName` String CODEC(ZSTD(1)),
    `MetricDescription` String CODEC(ZSTD(1)),
    `MetricUnit` String CODEC(ZSTD(1)),
    `Attributes` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `StartTimeUnix` DateTime64(9) CODEC(Delta(8), ZSTD(1)),
    `TimeUnix` DateTime64(9) CODEC(Delta(8), ZSTD(1)),
    `Value` Float64 CODEC(ZSTD(1)),
    `Flags` UInt32 CODEC(ZSTD(1)),
    `Exemplars.FilteredAttributes` Array(Map(LowCardinality(String), String)) CODEC(ZSTD(1)),
    `Exemplars.TimeUnix` Array(DateTime64(9)) CODEC(ZSTD(1)),
    `Exemplars.Value` Array(Float64) CODEC(ZSTD(1)),
    `Exemplars.SpanId` Array(String) CODEC(ZSTD(1)),
    `Exemplars.TraceId` Array(String) CODEC(ZSTD(1)),
    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_key mapKeys(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_value mapValues(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_key mapKeys(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_value mapValues(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    PROJECTION usage_by_time
    (
        SELECT TimeUnix, SuperlogProjectId, count()
        GROUP BY TimeUnix, SuperlogProjectId
    )
)
ENGINE = ReplicatedMergeTree('/clickhouse/{cluster}/tables/{shard}/{database}/{table}', '{replica}')
PARTITION BY toDate(TimeUnix)
ORDER BY (ServiceName, MetricName, Attributes, toUnixTimestamp64Nano(TimeUnix))
SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1
;
-- otel_metrics_sum
CREATE TABLE IF NOT EXISTS superlog.otel_metrics_sum ON CLUSTER superlog_ha
(
    `ResourceAttributes` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `SuperlogProjectId` LowCardinality(String) MATERIALIZED ResourceAttributes['superlog.project_id'],
    `ResourceSchemaUrl` String CODEC(ZSTD(1)),
    `ScopeName` String CODEC(ZSTD(1)),
    `ScopeVersion` String CODEC(ZSTD(1)),
    `ScopeAttributes` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `ScopeDroppedAttrCount` UInt32 CODEC(ZSTD(1)),
    `ScopeSchemaUrl` String CODEC(ZSTD(1)),
    `ServiceName` LowCardinality(String) CODEC(ZSTD(1)),
    `MetricName` String CODEC(ZSTD(1)),
    `MetricDescription` String CODEC(ZSTD(1)),
    `MetricUnit` String CODEC(ZSTD(1)),
    `Attributes` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `StartTimeUnix` DateTime64(9) CODEC(Delta(8), ZSTD(1)),
    `TimeUnix` DateTime64(9) CODEC(Delta(8), ZSTD(1)),
    `Value` Float64 CODEC(ZSTD(1)),
    `Flags` UInt32 CODEC(ZSTD(1)),
    `Exemplars.FilteredAttributes` Array(Map(LowCardinality(String), String)) CODEC(ZSTD(1)),
    `Exemplars.TimeUnix` Array(DateTime64(9)) CODEC(ZSTD(1)),
    `Exemplars.Value` Array(Float64) CODEC(ZSTD(1)),
    `Exemplars.SpanId` Array(String) CODEC(ZSTD(1)),
    `Exemplars.TraceId` Array(String) CODEC(ZSTD(1)),
    `AggregationTemporality` Int32 CODEC(ZSTD(1)),
    `IsMonotonic` Bool CODEC(Delta(1), ZSTD(1)),
    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_key mapKeys(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_value mapValues(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_key mapKeys(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_value mapValues(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    PROJECTION usage_by_time
    (
        SELECT TimeUnix, SuperlogProjectId, count()
        GROUP BY TimeUnix, SuperlogProjectId
    )
)
ENGINE = ReplicatedMergeTree('/clickhouse/{cluster}/tables/{shard}/{database}/{table}', '{replica}')
PARTITION BY toDate(TimeUnix)
ORDER BY (ServiceName, MetricName, Attributes, toUnixTimestamp64Nano(TimeUnix))
SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1
;
-- otel_metrics_summary
CREATE TABLE IF NOT EXISTS superlog.otel_metrics_summary ON CLUSTER superlog_ha
(
    `ResourceAttributes` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `SuperlogProjectId` LowCardinality(String) MATERIALIZED ResourceAttributes['superlog.project_id'],
    `ResourceSchemaUrl` String CODEC(ZSTD(1)),
    `ScopeName` String CODEC(ZSTD(1)),
    `ScopeVersion` String CODEC(ZSTD(1)),
    `ScopeAttributes` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `ScopeDroppedAttrCount` UInt32 CODEC(ZSTD(1)),
    `ScopeSchemaUrl` String CODEC(ZSTD(1)),
    `ServiceName` LowCardinality(String) CODEC(ZSTD(1)),
    `MetricName` String CODEC(ZSTD(1)),
    `MetricDescription` String CODEC(ZSTD(1)),
    `MetricUnit` String CODEC(ZSTD(1)),
    `Attributes` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `StartTimeUnix` DateTime64(9) CODEC(Delta(8), ZSTD(1)),
    `TimeUnix` DateTime64(9) CODEC(Delta(8), ZSTD(1)),
    `Count` UInt64 CODEC(Delta(8), ZSTD(1)),
    `Sum` Float64 CODEC(ZSTD(1)),
    `ValueAtQuantiles.Quantile` Array(Float64) CODEC(ZSTD(1)),
    `ValueAtQuantiles.Value` Array(Float64) CODEC(ZSTD(1)),
    `Flags` UInt32 CODEC(ZSTD(1)),
    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_key mapKeys(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_value mapValues(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_key mapKeys(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_value mapValues(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    PROJECTION usage_by_time
    (
        SELECT TimeUnix, SuperlogProjectId, count()
        GROUP BY TimeUnix, SuperlogProjectId
    )
)
ENGINE = ReplicatedMergeTree('/clickhouse/{cluster}/tables/{shard}/{database}/{table}', '{replica}')
PARTITION BY toDate(TimeUnix)
ORDER BY (ServiceName, MetricName, Attributes, toUnixTimestamp64Nano(TimeUnix))
SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1
;
-- otel_metrics_histogram
CREATE TABLE IF NOT EXISTS superlog.otel_metrics_histogram ON CLUSTER superlog_ha
(
    `ResourceAttributes` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `SuperlogProjectId` LowCardinality(String) MATERIALIZED ResourceAttributes['superlog.project_id'],
    `ResourceSchemaUrl` String CODEC(ZSTD(1)),
    `ScopeName` String CODEC(ZSTD(1)),
    `ScopeVersion` String CODEC(ZSTD(1)),
    `ScopeAttributes` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `ScopeDroppedAttrCount` UInt32 CODEC(ZSTD(1)),
    `ScopeSchemaUrl` String CODEC(ZSTD(1)),
    `ServiceName` LowCardinality(String) CODEC(ZSTD(1)),
    `MetricName` String CODEC(ZSTD(1)),
    `MetricDescription` String CODEC(ZSTD(1)),
    `MetricUnit` String CODEC(ZSTD(1)),
    `Attributes` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `StartTimeUnix` DateTime64(9) CODEC(Delta(8), ZSTD(1)),
    `TimeUnix` DateTime64(9) CODEC(Delta(8), ZSTD(1)),
    `Count` UInt64 CODEC(Delta(8), ZSTD(1)),
    `Sum` Float64 CODEC(ZSTD(1)),
    `BucketCounts` Array(UInt64) CODEC(ZSTD(1)),
    `ExplicitBounds` Array(Float64) CODEC(ZSTD(1)),
    `Exemplars.FilteredAttributes` Array(Map(LowCardinality(String), String)) CODEC(ZSTD(1)),
    `Exemplars.TimeUnix` Array(DateTime64(9)) CODEC(ZSTD(1)),
    `Exemplars.Value` Array(Float64) CODEC(ZSTD(1)),
    `Exemplars.SpanId` Array(String) CODEC(ZSTD(1)),
    `Exemplars.TraceId` Array(String) CODEC(ZSTD(1)),
    `Flags` UInt32 CODEC(ZSTD(1)),
    `Min` Float64 CODEC(ZSTD(1)),
    `Max` Float64 CODEC(ZSTD(1)),
    `AggregationTemporality` Int32 CODEC(ZSTD(1)),
    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_key mapKeys(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_value mapValues(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_key mapKeys(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_value mapValues(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    PROJECTION usage_by_time
    (
        SELECT TimeUnix, SuperlogProjectId, count()
        GROUP BY TimeUnix, SuperlogProjectId
    )
)
ENGINE = ReplicatedMergeTree('/clickhouse/{cluster}/tables/{shard}/{database}/{table}', '{replica}')
PARTITION BY toDate(TimeUnix)
ORDER BY (ServiceName, MetricName, Attributes, toUnixTimestamp64Nano(TimeUnix))
SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1
;
-- otel_metrics_exp_histogram
CREATE TABLE IF NOT EXISTS superlog.otel_metrics_exp_histogram ON CLUSTER superlog_ha
(
    `ResourceAttributes` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `SuperlogProjectId` LowCardinality(String) MATERIALIZED ResourceAttributes['superlog.project_id'],
    `ResourceSchemaUrl` String CODEC(ZSTD(1)),
    `ScopeName` String CODEC(ZSTD(1)),
    `ScopeVersion` String CODEC(ZSTD(1)),
    `ScopeAttributes` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `ScopeDroppedAttrCount` UInt32 CODEC(ZSTD(1)),
    `ScopeSchemaUrl` String CODEC(ZSTD(1)),
    `ServiceName` LowCardinality(String) CODEC(ZSTD(1)),
    `MetricName` String CODEC(ZSTD(1)),
    `MetricDescription` String CODEC(ZSTD(1)),
    `MetricUnit` String CODEC(ZSTD(1)),
    `Attributes` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `StartTimeUnix` DateTime64(9) CODEC(Delta(8), ZSTD(1)),
    `TimeUnix` DateTime64(9) CODEC(Delta(8), ZSTD(1)),
    `Count` UInt64 CODEC(Delta(8), ZSTD(1)),
    `Sum` Float64 CODEC(ZSTD(1)),
    `Scale` Int32 CODEC(ZSTD(1)),
    `ZeroCount` UInt64 CODEC(ZSTD(1)),
    `PositiveOffset` Int32 CODEC(ZSTD(1)),
    `PositiveBucketCounts` Array(UInt64) CODEC(ZSTD(1)),
    `NegativeOffset` Int32 CODEC(ZSTD(1)),
    `NegativeBucketCounts` Array(UInt64) CODEC(ZSTD(1)),
    `Exemplars.FilteredAttributes` Array(Map(LowCardinality(String), String)) CODEC(ZSTD(1)),
    `Exemplars.TimeUnix` Array(DateTime64(9)) CODEC(ZSTD(1)),
    `Exemplars.Value` Array(Float64) CODEC(ZSTD(1)),
    `Exemplars.SpanId` Array(String) CODEC(ZSTD(1)),
    `Exemplars.TraceId` Array(String) CODEC(ZSTD(1)),
    `Flags` UInt32 CODEC(ZSTD(1)),
    `Min` Float64 CODEC(ZSTD(1)),
    `Max` Float64 CODEC(ZSTD(1)),
    `AggregationTemporality` Int32 CODEC(ZSTD(1)),
    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_key mapKeys(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_value mapValues(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_key mapKeys(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_value mapValues(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    PROJECTION usage_by_time
    (
        SELECT TimeUnix, SuperlogProjectId, count()
        GROUP BY TimeUnix, SuperlogProjectId
    )
)
ENGINE = ReplicatedMergeTree('/clickhouse/{cluster}/tables/{shard}/{database}/{table}', '{replica}')
PARTITION BY toDate(TimeUnix)
ORDER BY (ServiceName, MetricName, Attributes, toUnixTimestamp64Nano(TimeUnix))
SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1
;
-- otel_traces_trace_id_ts
CREATE TABLE IF NOT EXISTS superlog.otel_traces_trace_id_ts ON CLUSTER superlog_ha
(
    `TraceId` String CODEC(ZSTD(1)),
    `Start` DateTime CODEC(Delta(4), ZSTD(1)),
    `End` DateTime CODEC(Delta(4), ZSTD(1)),
    INDEX idx_trace_id TraceId TYPE bloom_filter(0.01) GRANULARITY 1
)
ENGINE = ReplicatedMergeTree('/clickhouse/{cluster}/tables/{shard}/{database}/{table}', '{replica}')
PARTITION BY toDate(Start)
ORDER BY (TraceId, Start)
SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1
;
-- otel_traces_trace_id_ts_mv
CREATE MATERIALIZED VIEW IF NOT EXISTS superlog.otel_traces_trace_id_ts_mv ON CLUSTER superlog_ha TO superlog.otel_traces_trace_id_ts
(
    `TraceId` String,
    `Start` DateTime64(9),
    `End` DateTime64(9)
)
AS SELECT
    TraceId,
    min(Timestamp) AS Start,
    max(Timestamp) AS End
FROM superlog.otel_traces
WHERE TraceId != ''
GROUP BY TraceId
;
-- issue_activity_daily
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
-- issue_activity_daily_from_traces_mv
CREATE MATERIALIZED VIEW IF NOT EXISTS superlog.issue_activity_daily_from_traces_mv ON CLUSTER superlog_ha TO superlog.issue_activity_daily
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
-- issue_activity_daily_from_logs_mv
CREATE MATERIALIZED VIEW IF NOT EXISTS superlog.issue_activity_daily_from_logs_mv ON CLUSTER superlog_ha TO superlog.issue_activity_daily
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
-- events_per_minute (dashboard timeseries-count fast path; see
-- migrations/003_events_per_minute.sql for rationale + backfill notes)
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
-- events_per_minute_from_traces_mv
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
-- events_per_minute_from_logs_mv
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
-- otel_exceptions (exception-only projection; see migrations/004_otel_exceptions.sql
-- for rationale + backfill notes). One row per exception event so the Issues
-- feature + worker exception-ingest stop full ARRAY JOIN Events scans of otel_traces.
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
    `resource_attrs` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    `attrs` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
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
-- otel_exceptions_from_traces_mv
CREATE MATERIALIZED VIEW IF NOT EXISTS superlog.otel_exceptions_from_traces_mv ON CLUSTER superlog_ha TO superlog.otel_exceptions
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
-- otel_exceptions_from_logs_mv
CREATE MATERIALIZED VIEW IF NOT EXISTS superlog.otel_exceptions_from_logs_mv ON CLUSTER superlog_ha TO superlog.otel_exceptions
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
-- otel_traces_recent + otel_traces_summary (trace-list fast path; see
-- migrations/005_otel_traces_summary.sql for rationale + backfill notes). The
-- recent index gives the N most recently started trace_ids per project via a
-- bounded time-ordered scan; the summary supplies per-trace stats for those ids.
CREATE TABLE IF NOT EXISTS superlog.otel_traces_recent ON CLUSTER superlog_ha
(
    `project_id` String CODEC(ZSTD(1)),
    `ts` DateTime64(9) CODEC(Delta(8), ZSTD(1)),
    `trace_id` String CODEC(ZSTD(1))
)
ENGINE = ReplicatedMergeTree('/clickhouse/{cluster}/tables/{shard}/{database}/{table}', '{replica}')
PARTITION BY toDate(ts)
ORDER BY (project_id, ts)
TTL toDateTime(ts) + toIntervalDay(30)
SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1
;
-- otel_traces_recent_mv
CREATE MATERIALIZED VIEW IF NOT EXISTS superlog.otel_traces_recent_mv ON CLUSTER superlog_ha
TO superlog.otel_traces_recent
AS SELECT
    ResourceAttributes['superlog.project_id'] AS project_id,
    Timestamp AS ts,
    TraceId AS trace_id
FROM superlog.otel_traces
WHERE ResourceAttributes['superlog.project_id'] != '' AND TraceId != ''
;
-- otel_traces_summary
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
-- Anchored on the trace's last span (end), not its start, so the summary row
-- outlives the last otel_traces_recent row for the same trace (a trace whose
-- spans span days would otherwise lose its stats while recent still has it).
TTL toDateTime(fromUnixTimestamp64Nano(end_unix_nano)) + toIntervalDay(30)
SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1
;
-- otel_traces_summary_mv
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
