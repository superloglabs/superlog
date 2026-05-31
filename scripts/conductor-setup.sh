#!/usr/bin/env bash
#
# Conductor "setup command" for a freshly-created superlog workspace.
#
# Paste this into Conductor's per-workspace "Setup command" field:
#
#     pnpm conductor:setup
#
# Or call it directly:
#
#     bash scripts/conductor-setup.sh
#
# What it does:
#   1. Confirms we're in a git worktree (Conductor creates one per workspace).
#   2. Removes Docker resources for deleted worktrees, including stale portless
#      networks that can exhaust Docker's predefined address pools.
#   3. Runs the portless bootstrap with seed + auto-verify, so the workspace
#      lands with: deps installed, isolated docker stack running, migrations
#      applied, Acme org seeded, sample telemetry firing, OnboardingGate dismissed.
#   4. Prints a single "Ready at: <url>" line that Conductor's UI can pick up.
#
# Idempotent: re-running on a workspace that's already set up is safe — every
# inner step short-circuits when its work is already done.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

GIT_COMMON_DIR="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
if [[ -z "$GIT_COMMON_DIR" ]]; then
  echo "conductor-setup: not inside a git repo at $REPO_ROOT" >&2
  exit 1
fi
if [[ "$GIT_COMMON_DIR" == "$REPO_ROOT/.git" ]]; then
  cat >&2 <<'EOF'
conductor-setup: this is the main checkout, not a worktree.

Conductor workspaces should live under ~/conductor/workspaces/superlog/<name>/.
The main checkout uses the normal dev flow: `docker compose up -d && overmind start -D`.
EOF
  exit 1
fi

WT_NAME="$(basename "$REPO_ROOT")"
echo "conductor-setup: bootstrapping workspace '$WT_NAME' in portless mode"
echo

# Forward any extra args (e.g. --no-verify) so power users can tune behavior
# from Conductor without editing this file.
./scripts/worktree-bootstrap.sh --clean-orphans --seed "$@"

# tmp/worktree.json is the source of truth that bootstrap wrote. Pull the
# web URL back out so Conductor's setup-command log ends with a clickable line.
SUMMARY_FILE="$REPO_ROOT/tmp/worktree.json"
if [[ -f "$SUMMARY_FILE" ]]; then
  WEB_URL="$(node -e 'const fs=require("fs");const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(s.web_url||"")' "$SUMMARY_FILE" 2>/dev/null || true)"
  if [[ -n "$WEB_URL" ]]; then
    echo
    echo "Ready at: $WEB_URL"
    echo "Sign in with test@test.com / adminadmin (canonical worktree account)."
  fi
fi
