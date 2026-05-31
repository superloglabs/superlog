#!/usr/bin/env bash

set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: scripts/portless-run.sh <web|api|proxy> <command> [args...]" >&2
  exit 1
fi

service="$1"
shift

if [[ -z "${SUPERLOG_STACK_ENV_FILE:-}" ]]; then
  echo "SUPERLOG_STACK_ENV_FILE is required. Start through scripts/portless-stack.sh." >&2
  exit 1
fi

if [[ ! -f "$SUPERLOG_STACK_ENV_FILE" ]]; then
  echo "SUPERLOG_STACK_ENV_FILE does not exist: $SUPERLOG_STACK_ENV_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$SUPERLOG_STACK_ENV_FILE"
set +a

# Self-heal ~/.portless/routes.{json,lock} before invoking the portless CLI.
# Runs on every overmind service start (not just `portless-stack.sh start`),
# so `overmind restart web` recovers from the same failure modes:
#   1. routes.json is 0-bytes / missing / not a JSON array — portless then
#      reads it as empty and the user gets "No app registered for ...".
#   2. routes.lock/ (a directory portless uses as a mutex) was left held by
#      a crashed register call — addRoute blocks for ~30s then errors with
#      "Failed to acquire route lock", so the service prints "Proxy is
#      running" but never actually registers.
# See .agents/skills/worktree-bootstrap/SKILL.md "Common pitfalls".
portless_dir="$HOME/.portless"
routes_file="$portless_dir/routes.json"
lock_dir="$portless_dir/routes.lock"
mkdir -p "$portless_dir"
if [[ -d "$lock_dir" ]]; then
  echo "[portless-run:$service] clearing stale routes.lock at $lock_dir" >&2
  rm -rf "$lock_dir"
fi
if [[ ! -s "$routes_file" ]] \
  || ! node -e '
    const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    if (!Array.isArray(v)) process.exit(2);
  ' "$routes_file" >/dev/null 2>&1; then
  echo "[portless-run:$service] resetting invalid routes.json to []" >&2
  if [[ -s "$routes_file" ]]; then
    cp "$routes_file" "$routes_file.bak.$(date +%s)" 2>/dev/null || true
  fi
  echo '[]' > "$routes_file"
fi

case "$service" in
  web)
    route="${SUPERLOG_PORTLESS_WEB_NAME:?}"
    app_port="${WEB_APP_PORT:?}"
    ;;
  api)
    route="${SUPERLOG_PORTLESS_API_NAME:?}"
    app_port="${API_APP_PORT:?}"
    ;;
  proxy)
    route="${SUPERLOG_PORTLESS_PROXY_NAME:?}"
    app_port="${PROXY_APP_PORT:?}"
    ;;
  *)
    echo "unknown portless service: $service" >&2
    exit 1
    ;;
esac

exec pnpm exec portless --app-port "$app_port" "$route" "$@"
