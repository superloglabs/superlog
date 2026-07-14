#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP_HOME="$(mktemp -d)"
STACK_NAME="portless-port-test-$$"

cleanup() {
  rm -rf "$TMP_HOME" "$REPO_ROOT/tmp/portless-stacks/$STACK_NAME"
}
trap cleanup EXIT

output="$(HOME="$TMP_HOME" "$REPO_ROOT/scripts/portless-stack.sh" env --name "$STACK_NAME")"

if ! grep -Fqx "web:        https://$STACK_NAME.superlog.localhost" <<< "$output"; then
  echo "expected a missing proxy marker to preserve the privileged port 443 URL" >&2
  printf '%s\n' "$output" >&2
  exit 1
fi

if [[ -e "$TMP_HOME/.portless/proxy.port" ]]; then
  echo "expected a missing proxy marker not to be created implicitly" >&2
  exit 1
fi

output="$(
  HOME="$TMP_HOME" SUPERLOG_PORTLESS_PROXY_PORT=2443 \
    "$REPO_ROOT/scripts/portless-stack.sh" env --name "$STACK_NAME"
)"

if ! grep -Fqx "web:        https://$STACK_NAME.superlog.localhost:2443" <<< "$output"; then
  echo "expected the explicit proxy port override in generated URLs" >&2
  printf '%s\n' "$output" >&2
  exit 1
fi

if [[ "$(tr -d '[:space:]' < "$TMP_HOME/.portless/proxy.port")" != "2443" ]]; then
  echo "expected the explicit proxy port override to seed the marker" >&2
  exit 1
fi

output="$(
  HOME="$TMP_HOME" SUPERLOG_PORTLESS_OFFSET=999 \
    "$REPO_ROOT/scripts/portless-stack.sh" env --name "$STACK_NAME"
)"

if ! grep -Fqx "postgres:   localhost:16431" <<< "$output"; then
  echo "expected an explicit stack offset to avoid a hashed host-port collision" >&2
  printf '%s\n' "$output" >&2
  exit 1
fi

output="$(
  HOME="$TMP_HOME" SUPERLOG_PORTLESS_OFFSET=008 \
    "$REPO_ROOT/scripts/portless-stack.sh" env --name "$STACK_NAME"
)"
if ! grep -Fqx "postgres:   localhost:15440" <<< "$output"; then
  echo "expected zero-padded offsets to be parsed as decimal" >&2
  printf '%s\n' "$output" >&2
  exit 1
fi

FAKE_BIN="$TMP_HOME/bin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/docker" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *"FROM system.tables"*) printf '7\n' ;;
  *"FROM superlog.local_schema_migrations"*) printf '0\n' ;;
esac
exit 0
EOF
cat > "$FAKE_BIN/pnpm" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat > "$FAKE_BIN/overmind" <<'EOF'
#!/usr/bin/env bash
state="$HOME/.fake-overmind-running"
case "$1" in
  status) [[ -f "$state" ]] ;;
  quit) rm -f "$state" ;;
  start) touch "$state" ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$FAKE_BIN/docker" "$FAKE_BIN/pnpm" "$FAKE_BIN/overmind"

HOME="$TMP_HOME" PATH="$FAKE_BIN:$PATH" SUPERLOG_PORTLESS_OFFSET=7 \
  "$REPO_ROOT/scripts/portless-stack.sh" start --name "$STACK_NAME" >/dev/null
cat > "$TMP_HOME/.portless/routes.json" <<EOF
[
  {"hostname":"$STACK_NAME.superlog.localhost","pid":$$},
  {"hostname":"api.$STACK_NAME.superlog.localhost","pid":$$},
  {"hostname":"intake.$STACK_NAME.superlog.localhost","pid":$$}
]
EOF
output="$(
  HOME="$TMP_HOME" PATH="$FAKE_BIN:$PATH" SUPERLOG_PORTLESS_OFFSET=8 \
    "$REPO_ROOT/scripts/portless-stack.sh" start --name "$STACK_NAME"
)"
if ! grep -Fq 'overmind environment changed; restarting services' <<< "$output"; then
  echo "expected stack startup to restart overmind after a generated env change" >&2
  printf '%s\n' "$output" >&2
  exit 1
fi

rendered="$("$REPO_ROOT/scripts/clickhouse-apply-local-migrations.sh" --render \
  "$REPO_ROOT/infra/clickhouse/migrations/004_otel_exceptions.sql")"

if grep -qE 'ON CLUSTER|ReplicatedMergeTree' <<< "$rendered"; then
  echo "expected local ClickHouse migrations to remove cluster-only syntax" >&2
  exit 1
fi

if ! grep -Fq 'ENGINE = MergeTree' <<< "$rendered"; then
  echo "expected local ClickHouse migrations to use a single-node engine" >&2
  exit 1
fi

rendered="$($REPO_ROOT/scripts/clickhouse-apply-local-migrations.sh --render \
  "$REPO_ROOT/infra/clickhouse/migrations/008_otel_issue_candidates.sql")"

if grep -qE 'ON CLUSTER|ReplicatedMergeTree' <<< "$rendered"; then
  echo "expected the issue-candidate migration to render for single-node ClickHouse" >&2
  exit 1
fi

if ! grep -Fq 'CREATE TABLE IF NOT EXISTS superlog.otel_issue_candidates' <<< "$rendered"; then
  echo "expected the migration to create the arrival-ordered issue-candidate table" >&2
  exit 1
fi

if ! grep -Fq 'FROM superlog.otel_exceptions' <<< "$rendered"; then
  echo "expected issue candidates to cascade from the exception projection" >&2
  exit 1
fi

fake_bin="$TMP_HOME/bin"
fake_env="$TMP_HOME/stack.env"
fake_attempts="$TMP_HOME/portless-attempts"
mkdir -p "$fake_bin" "$TMP_HOME/.portless"
printf '[]\n' > "$TMP_HOME/.portless/routes.json"
cat > "$fake_env" <<'EOF'
SUPERLOG_PORTLESS_WEB_NAME=test-web
SUPERLOG_PORTLESS_API_NAME=test-api
SUPERLOG_PORTLESS_PROXY_NAME=test-proxy
WEB_APP_PORT=20001
API_APP_PORT=20002
PROXY_APP_PORT=20003
EOF
cat > "$fake_bin/pnpm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
attempts="${PORTLESS_TEST_ATTEMPTS:?}"
count=0
if [[ -f "$attempts" ]]; then
  count="$(cat "$attempts")"
fi
count=$((count + 1))
printf '%s\n' "$count" > "$attempts"
if [[ $count -eq 1 ]]; then
  echo "Error: Failed to acquire route lock" >&2
  exit 1
fi
echo "registered after retry"
EOF
chmod +x "$fake_bin/pnpm"

PATH="$fake_bin:$PATH" \
  HOME="$TMP_HOME" \
  PORTLESS_TEST_ATTEMPTS="$fake_attempts" \
  SUPERLOG_STACK_ENV_FILE="$fake_env" \
  "$REPO_ROOT/scripts/portless-run.sh" api true >/dev/null

if [[ "$(cat "$fake_attempts")" != "2" ]]; then
  echo "expected portless route registration to retry a transient lock collision" >&2
  exit 1
fi

echo "portless-stack proxy port: ok"
