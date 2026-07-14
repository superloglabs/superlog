#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIGRATIONS_DIR="$REPO_ROOT/infra/clickhouse/migrations"
cd "$REPO_ROOT"

render_migration() {
  sed -E \
    -e 's/ ON CLUSTER superlog_ha//g' \
    -e "s/ReplicatedAggregatingMergeTree\('[^']*', '[^']*'\)/AggregatingMergeTree/g" \
    -e "s/ReplicatedSummingMergeTree\('[^']*', '[^']*'\)/SummingMergeTree/g" \
    -e "s/ReplicatedMergeTree\('[^']*', '[^']*'\)/MergeTree/g" \
    "$1"
}

if [[ "${1:-}" == "--render" ]]; then
  if [[ -z "${2:-}" ]]; then
    echo "usage: $0 --render <migration.sql>" >&2
    exit 2
  fi
  render_migration "$2"
  exit 0
fi

CLICKHOUSE_DB="${CLICKHOUSE_DB:-superlog}"
: "${SUPERLOG_COMPOSE_PROJECT:?SUPERLOG_COMPOSE_PROJECT is required}"

clickhouse_client() {
  docker compose -p "$SUPERLOG_COMPOSE_PROJECT" exec -T clickhouse \
    clickhouse-client --database "$CLICKHOUSE_DB" "$@"
}

query() {
  clickhouse_client --query "$1"
}

echo "==> waiting for collector ClickHouse tables"
for _ in {1..60}; do
  raw_table_count="$(query "SELECT count() FROM system.tables WHERE database = '${CLICKHOUSE_DB}' AND name IN ('otel_traces', 'otel_logs', 'otel_metrics_gauge', 'otel_metrics_sum', 'otel_metrics_summary', 'otel_metrics_histogram', 'otel_metrics_exp_histogram') FORMAT TabSeparatedRaw" 2>/dev/null || true)"
  if [[ "$raw_table_count" == "7" ]]; then
    break
  fi
  sleep 1
done

if [[ "${raw_table_count:-}" != "7" ]]; then
  echo "collector did not create the required ClickHouse tables" >&2
  exit 1
fi

query "CREATE TABLE IF NOT EXISTS ${CLICKHOUSE_DB}.local_schema_migrations (name String, applied_at DateTime64(3, 'UTC')) ENGINE = MergeTree ORDER BY name" >/dev/null

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

for migration in "$MIGRATIONS_DIR"/*.sql; do
  name="$(basename "$migration")"
  applied="$(query "SELECT count() FROM ${CLICKHOUSE_DB}.local_schema_migrations WHERE name = '${name}' FORMAT TabSeparatedRaw")"
  if [[ "$applied" != "0" ]]; then
    continue
  fi

  echo "==> applying local ClickHouse migration: $name"
  rendered="$tmp_dir/$name"
  render_migration "$migration" > "$rendered"
  clickhouse_client --multiquery < "$rendered" >/dev/null
  query "INSERT INTO ${CLICKHOUSE_DB}.local_schema_migrations (name, applied_at) VALUES ('${name}', now64(3))" >/dev/null
done
