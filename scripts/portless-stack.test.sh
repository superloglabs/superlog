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

echo "portless-stack proxy port: ok"
