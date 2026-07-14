-- Exact metric-point counts are read repeatedly by billing and usage-limit
-- notifications. The raw OTel metric tables are ordered by
-- (ServiceName, MetricName, Attributes, TimeUnix), so a time-only window over
-- all projects cannot efficiently prune the large active parts. At production
-- volume, a five-minute count can otherwise read tens of millions of rows and
-- gigabytes of ResourceAttributes maps.
--
-- Keep the source tables' order (it serves metric-series reads) and add a
-- query-specific aggregate projection instead. It stores one count state per
-- exact nanosecond timestamp and project, ordered by time. Exact timestamps
-- preserve the billing cursor's (after, until] semantics; this is not a
-- minute-bucket estimate. Scraped metric series generally share timestamps,
-- so the projection is also much smaller than a second row-for-row index.
--
-- These replicated ALTERs intentionally do not use ON CLUSTER: Replicated
-- MergeTree propagates the metadata change and avoids enqueuing duplicate
-- materialization mutations through every replica.
--
-- Existing parts are NOT materialized by this file. New inserts get the
-- projection immediately. Backfill existing date partitions sequentially with
-- apps/worker/scripts/materialize-metric-usage-projections.ts; launching all
-- five large mutations together can saturate disk I/O and defeat the purpose
-- of the optimization.

ALTER TABLE superlog.otel_metrics_gauge
  ADD COLUMN IF NOT EXISTS SuperlogProjectId LowCardinality(String)
  MATERIALIZED ResourceAttributes['superlog.project_id'];
ALTER TABLE superlog.otel_metrics_gauge
  ADD PROJECTION IF NOT EXISTS usage_by_time
  (SELECT TimeUnix, SuperlogProjectId, count() GROUP BY TimeUnix, SuperlogProjectId);

ALTER TABLE superlog.otel_metrics_sum
  ADD COLUMN IF NOT EXISTS SuperlogProjectId LowCardinality(String)
  MATERIALIZED ResourceAttributes['superlog.project_id'];
ALTER TABLE superlog.otel_metrics_sum
  ADD PROJECTION IF NOT EXISTS usage_by_time
  (SELECT TimeUnix, SuperlogProjectId, count() GROUP BY TimeUnix, SuperlogProjectId);

ALTER TABLE superlog.otel_metrics_summary
  ADD COLUMN IF NOT EXISTS SuperlogProjectId LowCardinality(String)
  MATERIALIZED ResourceAttributes['superlog.project_id'];
ALTER TABLE superlog.otel_metrics_summary
  ADD PROJECTION IF NOT EXISTS usage_by_time
  (SELECT TimeUnix, SuperlogProjectId, count() GROUP BY TimeUnix, SuperlogProjectId);

ALTER TABLE superlog.otel_metrics_histogram
  ADD COLUMN IF NOT EXISTS SuperlogProjectId LowCardinality(String)
  MATERIALIZED ResourceAttributes['superlog.project_id'];
ALTER TABLE superlog.otel_metrics_histogram
  ADD PROJECTION IF NOT EXISTS usage_by_time
  (SELECT TimeUnix, SuperlogProjectId, count() GROUP BY TimeUnix, SuperlogProjectId);

ALTER TABLE superlog.otel_metrics_exp_histogram
  ADD COLUMN IF NOT EXISTS SuperlogProjectId LowCardinality(String)
  MATERIALIZED ResourceAttributes['superlog.project_id'];
ALTER TABLE superlog.otel_metrics_exp_histogram
  ADD PROJECTION IF NOT EXISTS usage_by_time
  (SELECT TimeUnix, SuperlogProjectId, count() GROUP BY TimeUnix, SuperlogProjectId);
