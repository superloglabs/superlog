#!/usr/bin/env bash
# Apply a ClickHouse migration to the prod cluster.
#
# Usage:
#   scripts/run-clickhouse-migration.sh infra/clickhouse/migrations/001_project_id_skip_index.sql
#
# Resolves the file locally and pipes its contents through `railway ssh` to
# clickhouse-client.
#
# This script has no migration ledger and is NOT safe to re-run blindly.
# `ADD INDEX … IF NOT EXISTS` is the only ClickHouse DDL form with a built-in
# guard; `MATERIALIZE INDEX`, `MATERIALIZE COLUMN`, `OPTIMIZE`, and most other
# ALTERs enqueue fresh background mutations every time they're invoked. Some
# of those rewrite every part — `MATERIALIZE INDEX` on otel_traces, for
# example, would re-scan ~900k rows per run.
#
# Apply each migration exactly once. Read the diff before invoking. If a
# migration must be reapplied, edit it to skip work that already happened.
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <path-to-sql-file>" >&2
  exit 2
fi

FILE="$1"
if [ ! -f "$FILE" ]; then
  echo "file not found: $FILE" >&2
  exit 2
fi

echo "Applying $FILE to prod clickhouse via Railway..." >&2
railway ssh --service clickhouse \
  "clickhouse-client --database=olly --multiquery --queries-file=/dev/stdin" \
  < "$FILE"

cat <<'VERIFY' >&2
Done. Verify with:

  railway ssh --service clickhouse "clickhouse-client --database=olly --query=\"SELECT table, name, type FROM system.data_skipping_indices WHERE table LIKE 'otel_%' AND name LIKE '%project%'\""
VERIFY
