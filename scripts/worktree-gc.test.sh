#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

FAKE_BIN="$TMP_DIR/bin"
mkdir -p "$FAKE_BIN"

cat > "$FAKE_BIN/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ "$*" == "worktree list --porcelain" ]]; then
  cat <<'GIT_WORKTREES'
worktree /Users/ash/projects/superlog-all/superlog
HEAD 0000000000000000000000000000000000000000
branch refs/heads/main

worktree /Users/ash/conductor/workspaces/superlog/accra
HEAD 1111111111111111111111111111111111111111
branch refs/heads/accra

worktree /Users/ash/conductor/workspaces/superlog/Milan V1
HEAD 2222222222222222222222222222222222222222
branch refs/heads/milan-v1

worktree /Users/ash/conductor/workspaces/superlog/---
HEAD 3333333333333333333333333333333333333333
branch refs/heads/dashes
GIT_WORKTREES
  exit 0
fi

echo "unexpected git args: $*" >&2
exit 1
EOF

cat > "$FAKE_BIN/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

scenario="${TEST_DOCKER_SCENARIO:-live_container}"

if [[ "$*" == *"--format {{.Names}}"* ]]; then
  if [[ "$scenario" == "live_container" ]]; then
    echo "superlog-portless-accra-postgres-1"
  fi
  exit 0
fi

if [[ "$*" == *"com.docker.compose.project.working_dir"* ]]; then
  if [[ "$scenario" == "live_raw_label" ]]; then
    printf 'claude-stack\t/Users/ash/projects/superlog-all/superlog/.claude/worktrees/Milan V1\n'
  fi
  exit 0
fi

if [[ "$*" == "network ls --format {{.Name}}" ]]; then
  case "$scenario" in
    live_slugged_name) echo "superlog-portless-milan-v1_default" ;;
    live_empty_slug_fallback) echo "superlog-portless-stack_default" ;;
    network_orphan) echo "superlog-portless-dubai_default" ;;
  esac
  exit 0
fi

echo "unexpected docker args: $*" >&2
exit 1
EOF

chmod +x "$FAKE_BIN/git" "$FAKE_BIN/docker"

output="$(TEST_DOCKER_SCENARIO=live_container PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/scripts/worktree-gc.sh" --list)"

if [[ -n "$output" ]]; then
  echo "expected live Conductor worktree resources to be omitted from --list" >&2
  echo "actual output:" >&2
  printf '%s\n' "$output" >&2
  exit 1
fi

output="$(TEST_DOCKER_SCENARIO=live_slugged_name PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/scripts/worktree-gc.sh" --list)"

if [[ -n "$output" ]]; then
  echo "expected slugified live worktree resources to be omitted from --list" >&2
  echo "actual output:" >&2
  printf '%s\n' "$output" >&2
  exit 1
fi

output="$(TEST_DOCKER_SCENARIO=live_raw_label PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/scripts/worktree-gc.sh" --list)"

if [[ -n "$output" ]]; then
  echo "expected raw label-based live worktree resources to be omitted from --list" >&2
  echo "actual output:" >&2
  printf '%s\n' "$output" >&2
  exit 1
fi

output="$(TEST_DOCKER_SCENARIO=live_empty_slug_fallback PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/scripts/worktree-gc.sh" --list)"

if [[ -n "$output" ]]; then
  echo "expected empty-slug live worktree resources to use the stack fallback" >&2
  echo "actual output:" >&2
  printf '%s\n' "$output" >&2
  exit 1
fi

output="$(TEST_DOCKER_SCENARIO=network_orphan PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/scripts/worktree-gc.sh" --list)"

if [[ "$output" != *"superlog-portless-dubai"* || "$output" != *"(worktree: dubai)"* ]]; then
  echo "expected orphan portless networks to be reported by --list" >&2
  echo "actual output:" >&2
  printf '%s\n' "$output" >&2
  exit 1
fi

echo "worktree-gc: ok"
