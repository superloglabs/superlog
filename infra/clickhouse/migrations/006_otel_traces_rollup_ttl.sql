-- Match the source retention on the trace-list rollup tables (005). otel_traces
-- carries a 30-day TTL (`toDateTime(Timestamp) + toIntervalDay(30)`); the derived
-- tables were created without one, so they would grow unbounded — and
-- otel_traces_recent is one row per span, i.e. the full span history. Give both
-- the same 30-day TTL so the rollup ages out in lockstep with the spans it
-- summarizes.
--
-- MODIFY TTL is idempotent and, with ttl_only_drop_parts = 1 (set at creation),
-- enforces by dropping whole expired parts rather than rewriting rows. Apply once
-- against the HA cluster.

ALTER TABLE superlog.otel_traces_recent ON CLUSTER superlog_ha
  MODIFY TTL toDateTime(ts) + toIntervalDay(30)
;

ALTER TABLE superlog.otel_traces_summary ON CLUSTER superlog_ha
  MODIFY TTL toDateTime(start) + toIntervalDay(30)
;
