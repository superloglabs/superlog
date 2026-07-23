-- ClickHouse does not select the project set index from migration 001 when its
-- expression reads a key directly from ResourceAttributes. Expose that value
-- as a scalar materialized column and index the scalar instead.
--
-- Existing parts are intentionally not materialized here: applying local
-- migrations must not start an unbounded whole-table mutation. New inserts get
-- the index immediately. Deployments that need historical pruning can
-- materialize idx_superlog_project_id_materialized in a separately monitored
-- operation.

ALTER TABLE superlog.otel_logs
  ADD COLUMN IF NOT EXISTS SuperlogProjectId LowCardinality(String)
    MATERIALIZED ResourceAttributes['superlog.project_id'];

ALTER TABLE superlog.otel_logs
  ADD INDEX IF NOT EXISTS idx_superlog_project_id_materialized
    SuperlogProjectId TYPE set(0) GRANULARITY 1;

ALTER TABLE superlog.otel_traces
  ADD COLUMN IF NOT EXISTS SuperlogProjectId LowCardinality(String)
    MATERIALIZED ResourceAttributes['superlog.project_id'];

ALTER TABLE superlog.otel_traces
  ADD INDEX IF NOT EXISTS idx_superlog_project_id_materialized
    SuperlogProjectId TYPE set(0) GRANULARITY 1;
