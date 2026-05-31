#!/usr/bin/env bash

set -euo pipefail

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

exec "$@"
