-- Bound the growth of the trace-list rollup tables (005) with a 30-day
-- retention. otel_traces_recent is one row per span, i.e. the full span history,
-- so without a TTL it accumulates forever; otel_traces_summary is one row per
-- trace. Capping the derived tables (rather than the raw table) is safe because
-- the read path's coverage gate falls back to the raw scan for any window the
-- rollup no longer covers, so a shorter derived retention never under-reports —
-- it just serves older windows the slow way.
--
-- Anchor choice matters:
--   * otel_traces_recent expires each span row 30 days after that span's own ts.
--   * otel_traces_summary must expire 30 days after the trace's LAST span, not
--     its first — otherwise a trace whose spans span several days would lose its
--     summary row while later otel_traces_recent rows for the same trace still
--     exist, leaving the fast path able to find the trace_id but with no stats.
--     `end_unix_nano` is the trace's max span end, so anchoring on it makes the
--     summary outlive (or expire with) the last recent row.
--
-- MODIFY TTL is idempotent and, with ttl_only_drop_parts = 1 (set at creation),
-- enforces by dropping whole expired parts rather than rewriting rows. Apply once
-- against the HA cluster.

ALTER TABLE superlog.otel_traces_recent ON CLUSTER superlog_ha
  MODIFY TTL toDateTime(ts) + toIntervalDay(30)
;

ALTER TABLE superlog.otel_traces_summary ON CLUSTER superlog_ha
  MODIFY TTL toDateTime(fromUnixTimestamp64Nano(end_unix_nano)) + toIntervalDay(30)
;
