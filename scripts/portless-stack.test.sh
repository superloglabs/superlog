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
output="$(
  HOME="$TMP_HOME" PATH="$FAKE_BIN:$PATH" SUPERLOG_PORTLESS_OFFSET=8 \
    "$REPO_ROOT/scripts/portless-stack.sh" start --name "$STACK_NAME"
)"
if ! grep -Fq 'overmind environment changed; restarting services' <<< "$output"; then
  echo "expected stack startup to restart overmind after a generated env change" >&2
  printf '%s\n' "$output" >&2
  exit 1
fi

echo "portless-stack proxy port: ok"
