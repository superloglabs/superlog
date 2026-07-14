#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

usage() {
  cat <<'USAGE'
Usage:
  scripts/portless-stack.sh start [--name <stack>]
  scripts/portless-stack.sh stop [--name <stack>]
  scripts/portless-stack.sh status [--name <stack>]
  scripts/portless-stack.sh env [--name <stack>]

Starts an isolated local stack:
  - separate Docker Compose project and volumes
  - separate host ports for Postgres, ClickHouse, and the collector
  - Drizzle migrations against that stack's Postgres
  - api, web, and intake proxy behind portless .localhost routes
USAGE
}

slugify() {
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9-]+/-/g; s/^-+//; s/-+$//; s/-+/-/g'
}

default_stack_name() {
  local root branch superproject
  root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

  # When checked out as a git submodule, the stack identity is the superproject
  # worktree, not this submodule dir (which is always named the same).
  # Keep in sync with scripts/worktree-bootstrap.sh.
  superproject="$(git rev-parse --show-superproject-working-tree 2>/dev/null || true)"
  if [[ -n "$superproject" ]]; then
    basename "$superproject"
    return
  fi

  case "$root" in
    */.claude/worktrees/*)
      basename "$root"
      return
      ;;
  esac

  branch="$(git branch --show-current 2>/dev/null || true)"
  if [[ -n "$branch" ]]; then
    printf '%s\n' "$branch"
  else
    basename "$root"
  fi
}

command="${1:-start}"
if [[ $# -gt 0 ]]; then
  shift
fi

raw_name=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --)
      shift
      ;;
    --name)
      raw_name="${2:-}"
      if [[ -z "$raw_name" ]]; then
        echo "--name requires a value" >&2
        exit 1
      fi
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$raw_name" ]]; then
  raw_name="$(default_stack_name)"
fi

STACK_NAME="$(slugify "$raw_name")"
if [[ -z "$STACK_NAME" ]]; then
  STACK_NAME="stack"
fi

STACK_DIR="$REPO_ROOT/tmp/portless-stacks/$STACK_NAME"
ENV_FILE="$STACK_DIR/env"
OVERMIND_ENV_CHECKSUM_FILE="$STACK_DIR/overmind-env.checksum"
LOG_DIR="$STACK_DIR/logs"
OVERMIND_SOCKET="$STACK_DIR/overmind.sock"
# macOS limits unix-socket paths to ~104 bytes. When the worktree path makes
# $STACK_DIR/overmind.sock too long (typical inside .claude/worktrees/...),
# fall back to a short /tmp path so `overmind start` doesn't bind: invalid argument.
if [[ ${#OVERMIND_SOCKET} -ge 100 ]]; then
  OVERMIND_SOCKET="${TMPDIR:-/tmp}/sl-pl-${STACK_NAME}.sock"
fi
COMPOSE_PROJECT="superlog-portless-$STACK_NAME"

checksum="$(printf '%s' "$STACK_NAME" | cksum | awk '{print $1}')"
offset=$(( checksum % 1000 ))
if [[ -n "${SUPERLOG_PORTLESS_OFFSET:-}" ]]; then
  if [[ ! "$SUPERLOG_PORTLESS_OFFSET" =~ ^[0-9]+$ ]] ||
    (( 10#$SUPERLOG_PORTLESS_OFFSET < 0 || 10#$SUPERLOG_PORTLESS_OFFSET > 999 )); then
    echo "SUPERLOG_PORTLESS_OFFSET must be an integer from 0 to 999" >&2
    exit 1
  fi
  offset=$(( 10#$SUPERLOG_PORTLESS_OFFSET ))
fi

POSTGRES_HOST_PORT=$(( 15432 + offset ))
CLICKHOUSE_HTTP_HOST_PORT=$(( 18123 + offset ))
CLICKHOUSE_TCP_HOST_PORT=$(( 19000 + offset ))
COLLECTOR_GRPC_HOST_PORT=$(( 14317 + offset ))
COLLECTOR_HTTP_HOST_PORT=$(( 14318 + offset ))
WEB_APP_PORT=$(( 20000 + (offset * 3) ))
API_APP_PORT=$(( WEB_APP_PORT + 1 ))
PROXY_APP_PORT=$(( WEB_APP_PORT + 2 ))

if [[ "$STACK_NAME" == "main" ]]; then
  WEB_ROUTE="superlog"
  API_ROUTE="api.superlog"
  PROXY_ROUTE="intake.superlog"
else
  WEB_ROUTE="$STACK_NAME.superlog"
  API_ROUTE="api.$STACK_NAME.superlog"
  PROXY_ROUTE="intake.$STACK_NAME.superlog"
fi

# Detect the portless proxy port. When portless is installed privileged it
# binds 443 (no suffix needed); otherwise it picks a non-privileged port and
# writes it to ~/.portless/proxy.port. Embedding the port in the URL is
# required so any process — including node fetch in seed scripts — can hit
# the route.
PORTLESS_PORT_FILE="$HOME/.portless/proxy.port"
PORT_SUFFIX=""
PROXY_PORT_VAL=""
if [[ -s "$PORTLESS_PORT_FILE" ]]; then
  PROXY_PORT_VAL="$(tr -d '[:space:]' < "$PORTLESS_PORT_FILE")"
fi
# Preserve portless' native no-marker behavior: privileged installs bind 443.
# Non-privileged setup can opt into a shared port explicitly; writing the marker
# keeps URL generation and the portless CLI in agreement on first boot.
if [[ ! "$PROXY_PORT_VAL" =~ ^[0-9]+$ ]] && [[ -n "${SUPERLOG_PORTLESS_PROXY_PORT:-}" ]]; then
  if [[ ! "$SUPERLOG_PORTLESS_PROXY_PORT" =~ ^[0-9]+$ ]]; then
    echo "SUPERLOG_PORTLESS_PROXY_PORT must be a numeric port" >&2
    exit 1
  fi
  PROXY_PORT_VAL="$SUPERLOG_PORTLESS_PROXY_PORT"
  mkdir -p "$(dirname "$PORTLESS_PORT_FILE")"
  printf '%s\n' "$PROXY_PORT_VAL" > "$PORTLESS_PORT_FILE"
  echo "==> portless proxy port was unset; using explicit port $PROXY_PORT_VAL" >&2
fi
if [[ "$PROXY_PORT_VAL" =~ ^[0-9]+$ ]] && [[ "$PROXY_PORT_VAL" != "443" ]]; then
  PORT_SUFFIX=":$PROXY_PORT_VAL"
fi

WEB_URL="https://$WEB_ROUTE.localhost$PORT_SUFFIX"
API_URL="https://$API_ROUTE.localhost$PORT_SUFFIX"
PROXY_URL="https://$PROXY_ROUTE.localhost$PORT_SUFFIX"

write_env_file() {
  mkdir -p "$STACK_DIR" "$LOG_DIR"
  {
    printf '# Generated by scripts/portless-stack.sh. Do not edit by hand.\n'
    printf 'SUPERLOG_STACK_NAME=%s\n' "$STACK_NAME"
    printf 'SUPERLOG_COMPOSE_PROJECT=%s\n' "$COMPOSE_PROJECT"
    printf 'SUPERLOG_ENV_FILE=%s\n' "$ENV_FILE"
    printf 'SUPERLOG_LOG_DIR=%s\n' "$LOG_DIR"
    printf 'POSTGRES_HOST_PORT=%s\n' "$POSTGRES_HOST_PORT"
    printf 'CLICKHOUSE_HTTP_HOST_PORT=%s\n' "$CLICKHOUSE_HTTP_HOST_PORT"
    printf 'CLICKHOUSE_TCP_HOST_PORT=%s\n' "$CLICKHOUSE_TCP_HOST_PORT"
    printf 'COLLECTOR_GRPC_HOST_PORT=%s\n' "$COLLECTOR_GRPC_HOST_PORT"
    printf 'COLLECTOR_HTTP_HOST_PORT=%s\n' "$COLLECTOR_HTTP_HOST_PORT"
    printf 'WEB_APP_PORT=%s\n' "$WEB_APP_PORT"
    printf 'API_APP_PORT=%s\n' "$API_APP_PORT"
    printf 'PROXY_APP_PORT=%s\n' "$PROXY_APP_PORT"
    printf 'DATABASE_URL=postgres://postgres:postgres@localhost:%s/superlog\n' "$POSTGRES_HOST_PORT"
    printf 'CLICKHOUSE_URL=http://localhost:%s\n' "$CLICKHOUSE_HTTP_HOST_PORT"
    printf 'CLICKHOUSE_DB=superlog\n'
    printf 'CLICKHOUSE_USER=default\n'
    printf 'CLICKHOUSE_PASSWORD=\n'
    printf 'COLLECTOR_URL=http://localhost:%s\n' "$COLLECTOR_HTTP_HOST_PORT"
    printf 'WEB_ORIGIN=%s\n' "$WEB_URL"
    printf 'GATEWAY_PUBLIC_URL=%s\n' "$API_URL"
    printf 'API_BASE_URL=%s\n' "$API_URL"
    printf 'VITE_API_URL=%s\n' "$API_URL"
    # Better Auth's baseURL has to match the actual origin serving /api/auth/*
    # or state cookies get scoped to the wrong host. Without this, the worktree
    # falls back to apps/api/.env's localhost:4100 and every OAuth attempt
    # (and any cookie round-trip) fails with "please restart the process".
    printf 'BETTER_AUTH_URL=%s\n' "$API_URL"
    printf 'GITHUB_INSTALL_OAUTH_REDIRECT_URL=%s/github/install/callback\n' "$API_URL"
    printf 'GITHUB_AUTHOR_OAUTH_REDIRECT_URL=%s/github/author/callback\n' "$API_URL"
    printf 'SLACK_OAUTH_REDIRECT_URL=%s/slack/oauth/callback\n' "$API_URL"
    printf 'LINEAR_OAUTH_REDIRECT_URL=%s/linear/oauth/callback\n' "$API_URL"
    printf 'SUPERLOG_PORTLESS_WEB_NAME=%s\n' "$WEB_ROUTE"
    printf 'SUPERLOG_PORTLESS_API_NAME=%s\n' "$API_ROUTE"
    printf 'SUPERLOG_PORTLESS_PROXY_NAME=%s\n' "$PROXY_ROUTE"
    printf 'SUPERLOG_PORTLESS_WEB_URL=%s\n' "$WEB_URL"
    printf 'SUPERLOG_PORTLESS_API_URL=%s\n' "$API_URL"
    printf 'SUPERLOG_PORTLESS_PROXY_URL=%s\n' "$PROXY_URL"
  } > "$ENV_FILE"
}

compose() {
  docker compose --env-file "$ENV_FILE" -p "$COMPOSE_PROJECT" "$@"
}

run_with_env() {
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  "$@"
}

wait_for_overmind_stop() {
  local attempt
  for attempt in {1..50}; do
    if ! overmind status --socket "$OVERMIND_SOCKET" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done
  echo "overmind did not stop at $OVERMIND_SOCKET" >&2
  return 1
}

print_summary() {
  printf 'stack:      %s\n' "$STACK_NAME"
  printf 'web:        %s\n' "$WEB_URL"
  printf 'api:        %s\n' "$API_URL"
  printf 'intake:     %s\n' "$PROXY_URL"
  printf 'postgres:   localhost:%s\n' "$POSTGRES_HOST_PORT"
  printf 'clickhouse: http://localhost:%s\n' "$CLICKHOUSE_HTTP_HOST_PORT"
  printf 'collector:  http://localhost:%s\n' "$COLLECTOR_HTTP_HOST_PORT"
  printf 'app ports:  web=%s api=%s proxy=%s\n' "$WEB_APP_PORT" "$API_APP_PORT" "$PROXY_APP_PORT"
  printf 'logs:       %s\n' "$LOG_DIR"
  printf 'socket:     %s\n' "$OVERMIND_SOCKET"
}

ensure_portless_routes_healthy() {
  # ~/.portless/routes.json is a shared JSON array that the portless proxy
  # uses to dispatch <name>.superlog.localhost to a local port. Two failure
  # modes we've seen:
  #
  #   (a) `routes.json` is zero-bytes, missing, or non-array JSON. portless'
  #       loadRoutes() then treats the table as empty and the user gets the
  #       "No app registered for <name>.superlog.localhost" landing page.
  #       Symptom shows up even when `overmind ps` says services are running.
  #
  #   (b) `routes.lock/` (a directory — portless uses mkdir-as-mutex) is
  #       held by a process that crashed mid-write. Portless 0.11 retries for
  #       5s and reclaims locks older than 10s. Never remove a fresh lock here:
  #       a sibling service may be registering concurrently, and deleting its
  #       lock can overwrite routes.json with an incomplete snapshot.
  #
  # Reset both before bringing the stack up. Backups go next to the file so
  # we can post-mortem if needed.
  local portless_dir="$HOME/.portless"
  local routes_file="$portless_dir/routes.json"
  local lock_dir="$portless_dir/routes.lock"

  mkdir -p "$portless_dir"
  local fresh_lock=0

  if [[ -d "$lock_dir" ]] && node -e '
    const ageMs = Date.now() - require("fs").statSync(process.argv[1]).mtimeMs;
    process.exit(ageMs > 10_000 ? 0 : 1);
  ' "$lock_dir"; then
    echo "==> clearing stale portless routes.lock at $lock_dir" >&2
    rm -rf "$lock_dir"
  fi
  if [[ -d "$lock_dir" ]]; then
    fresh_lock=1
  fi

  local needs_reset=0
  if [[ ! -s "$routes_file" ]]; then
    needs_reset=1
  elif ! node -e '
    const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    if (!Array.isArray(v)) process.exit(2);
  ' "$routes_file" >/dev/null 2>&1; then
    needs_reset=1
  fi

  if [[ "$needs_reset" -eq 1 ]]; then
    if [[ "$fresh_lock" -eq 1 ]]; then
      echo "==> deferring portless routes repair while registration lock is fresh" >&2
    else
      echo "==> portless routes file missing/invalid, resetting $routes_file to []" >&2
      if [[ -s "$routes_file" ]]; then
        cp "$routes_file" "$routes_file.bak.$(date +%s)" 2>/dev/null || true
      fi
      echo '[]' > "$routes_file"
    fi
  fi
}

routes_registered() {
  local routes_file="$HOME/.portless/routes.json"
  node -e '
    const routes = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const required = new Set(process.argv.slice(2));
    for (const route of routes) {
      if (!required.has(route.hostname)) continue;
      try {
        process.kill(route.pid, 0);
        required.delete(route.hostname);
      } catch {}
    }
    if (required.size > 0) process.exit(1);
  ' "$routes_file" \
    "${WEB_ROUTE}.localhost" \
    "${API_ROUTE}.localhost" \
    "${PROXY_ROUTE}.localhost"
}

start_stack() {
  write_env_file
  ensure_portless_routes_healthy

  compose up -d --wait --wait-timeout 120 postgres clickhouse collector

  run_with_env pnpm --filter @superlog/db db:migrate
  run_with_env ./scripts/clickhouse-apply-local-migrations.sh

  if overmind status --socket "$OVERMIND_SOCKET" >/dev/null 2>&1 && ! routes_registered; then
    echo "==> portless routes are missing; restarting services to register them"
    overmind quit --socket "$OVERMIND_SOCKET" >/dev/null
    for _ in {1..50}; do
      if ! overmind status --socket "$OVERMIND_SOCKET" >/dev/null 2>&1; then
        break
      fi
      sleep 0.1
    done
    # Concurrent service unregisters can leave a partial routes write while
    # overmind is shutting down. Repair it before the new processes register.
    ensure_portless_routes_healthy
  fi

  local desired_env_checksum running_env_checksum=""
  desired_env_checksum="$(cksum "$ENV_FILE" | awk '{print $1 ":" $2}')"
  if [[ -f "$OVERMIND_ENV_CHECKSUM_FILE" ]]; then
    running_env_checksum="$(tr -d '[:space:]' < "$OVERMIND_ENV_CHECKSUM_FILE")"
  fi

  local overmind_running=0
  if overmind status --socket "$OVERMIND_SOCKET" >/dev/null 2>&1; then
    overmind_running=1
    if [[ "$running_env_checksum" != "$desired_env_checksum" ]]; then
      echo "==> overmind environment changed; restarting services"
      overmind quit --socket "$OVERMIND_SOCKET" >/dev/null 2>&1 || true
      wait_for_overmind_stop
      overmind_running=0
    else
      echo "==> overmind already running at $OVERMIND_SOCKET"
    fi
  fi

  if [[ "$overmind_running" -eq 0 ]]; then
    SUPERLOG_STACK_ENV_FILE="$ENV_FILE" \
      SUPERLOG_LOG_DIR="$LOG_DIR" \
      overmind start -D --procfile Procfile.portless --socket "$OVERMIND_SOCKET" --no-port
  fi
  printf '%s\n' "$desired_env_checksum" > "$OVERMIND_ENV_CHECKSUM_FILE"

  print_summary
}

stop_stack() {
  write_env_file

  overmind quit --socket "$OVERMIND_SOCKET" >/dev/null 2>&1 || true
  rm -f "$OVERMIND_ENV_CHECKSUM_FILE"
  compose down
}

status_stack() {
  write_env_file

  printf 'Overmind:\n'
  overmind status --socket "$OVERMIND_SOCKET" || true
  printf '\nDocker Compose:\n'
  compose ps
  printf '\nRoutes:\n'
  pnpm exec portless list || true
}

case "$command" in
  start) start_stack ;;
  stop) stop_stack ;;
  status|ps) status_stack ;;
  env)
    write_env_file
    print_summary
    printf 'env file:   %s\n' "$ENV_FILE"
    ;;
  -h|--help) usage ;;
  *)
    echo "unknown command: $command" >&2
    usage >&2
    exit 1
    ;;
esac
