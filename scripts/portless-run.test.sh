#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP_HOME="$(mktemp -d)"
trap 'rm -rf "$TMP_HOME"' EXIT

mkdir -p "$TMP_HOME/bin" "$TMP_HOME/.portless" "$TMP_HOME/stack"
cat > "$TMP_HOME/bin/pnpm" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$TMP_HOME/bin/pnpm"
cat > "$TMP_HOME/stack/env" <<'EOF'
SUPERLOG_PORTLESS_API_NAME=test-api
API_APP_PORT=19999
EOF

printf '{}\n' > "$TMP_HOME/.portless/routes.json"
mkdir "$TMP_HOME/.portless/routes.lock"
HOME="$TMP_HOME" PATH="$TMP_HOME/bin:$PATH" SUPERLOG_STACK_ENV_FILE="$TMP_HOME/stack/env" \
  "$REPO_ROOT/scripts/portless-run.sh" api true
if [[ "$(tr -d '[:space:]' < "$TMP_HOME/.portless/routes.json")" != "{}" ]]; then
  echo "fresh route locks must prevent routes.json reset" >&2
  exit 1
fi

rmdir "$TMP_HOME/.portless/routes.lock"
HOME="$TMP_HOME" PATH="$TMP_HOME/bin:$PATH" SUPERLOG_STACK_ENV_FILE="$TMP_HOME/stack/env" \
  "$REPO_ROOT/scripts/portless-run.sh" api true
if [[ "$(tr -d '[:space:]' < "$TMP_HOME/.portless/routes.json")" != "[]" ]]; then
  echo "invalid routes.json should reset when no registration owns the lock" >&2
  exit 1
fi

echo "portless-run route lock: ok"
