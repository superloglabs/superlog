-- Add a targeted `set` skip index on `superlog.project_id` to every otel_*
-- table. Per-project read queries currently rely on the generic bloom_filter
-- on `mapValues(ResourceAttributes)` to prune granules; at ~100 projects this
-- works, but as cardinality grows (toward 20k+ for Nanocorp-style customers)
-- the bloom filter degrades and queries scan more granules than necessary.
--
-- A `set(0)` index on the specific map expression stores the exact set of
-- distinct project_id values per granule. (0 means "unbounded cardinality"
-- within the granule — fine, each granule typically has 1-2 projects.)
-- Granules whose set doesn't contain the queried project_id are skipped
-- with no false positives.
--
-- Granularity 4 = the index granule covers 4 data granules (8192 × 4 =
-- 32,768 rows). Higher granularity = smaller index, lower selectivity at
-- the granule boundary; 4 is a reasonable starting point.
--
-- Run ONCE. The ADD INDEX statements are IF NOT EXISTS so the structural
-- changes are individually safe to retry, but MATERIALIZE INDEX has no
-- guard — every invocation enqueues a fresh background mutation that
-- re-scans every part. The MATERIALIZE step is async and may take hours
-- on otel_traces; writes are not blocked.

ALTER TABLE otel_traces
  ADD INDEX IF NOT EXISTS idx_superlog_project_id
    ResourceAttributes['superlog.project_id']
    TYPE set(0) GRANULARITY 4;
ALTER TABLE otel_traces MATERIALIZE INDEX idx_superlog_project_id;

ALTER TABLE otel_logs
  ADD INDEX IF NOT EXISTS idx_superlog_project_id
    ResourceAttributes['superlog.project_id']
    TYPE set(0) GRANULARITY 4;
ALTER TABLE otel_logs MATERIALIZE INDEX idx_superlog_project_id;

ALTER TABLE otel_metrics_gauge
  ADD INDEX IF NOT EXISTS idx_superlog_project_id
    ResourceAttributes['superlog.project_id']
    TYPE set(0) GRANULARITY 4;
ALTER TABLE otel_metrics_gauge MATERIALIZE INDEX idx_superlog_project_id;

ALTER TABLE otel_metrics_sum
  ADD INDEX IF NOT EXISTS idx_superlog_project_id
    ResourceAttributes['superlog.project_id']
    TYPE set(0) GRANULARITY 4;
ALTER TABLE otel_metrics_sum MATERIALIZE INDEX idx_superlog_project_id;

ALTER TABLE otel_metrics_summary
  ADD INDEX IF NOT EXISTS idx_superlog_project_id
    ResourceAttributes['superlog.project_id']
    TYPE set(0) GRANULARITY 4;
ALTER TABLE otel_metrics_summary MATERIALIZE INDEX idx_superlog_project_id;

ALTER TABLE otel_metrics_histogram
  ADD INDEX IF NOT EXISTS idx_superlog_project_id
    ResourceAttributes['superlog.project_id']
    TYPE set(0) GRANULARITY 4;
ALTER TABLE otel_metrics_histogram MATERIALIZE INDEX idx_superlog_project_id;

ALTER TABLE otel_metrics_exp_histogram
  ADD INDEX IF NOT EXISTS idx_superlog_project_id
    ResourceAttributes['superlog.project_id']
    TYPE set(0) GRANULARITY 4;
ALTER TABLE otel_metrics_exp_histogram MATERIALIZE INDEX idx_superlog_project_id;
