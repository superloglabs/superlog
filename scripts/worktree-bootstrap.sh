#!/usr/bin/env bash
#
# One-command setup for a Claude/Codex worktree.
#
#   pnpm worktree:bootstrap                       # default: portless, fully isolated stack
#   pnpm worktree:bootstrap --shared              # share main's docker infra, port-offset overmind
#   pnpm worktree:bootstrap --seed                # + dev org / project / ingest API key
#   pnpm worktree:bootstrap --seed --telemetry    # + post sample OTLP through the worktree's proxy
#                                                 # (telemetry runs AFTER overmind, see scripts/worktree-verify.sh)
#
# Idempotent: re-run any time. Writes a single summary file at
# tmp/worktree.json with the URLs / keys the agent should use next.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

usage() {
  cat <<'USAGE'
Usage: pnpm worktree:bootstrap [options]

Modes (default: portless):
  --portless         Default — fully isolated stack: own postgres / clickhouse / collector,
                     HTTPS routes via portless. No host-port collisions between worktrees.
  --shared           Share main repo's docker infra, isolated pg database per worktree, +offset ports.
                     Fragile when orphan containers from other worktrees hold the shared host ports.

Seeding (optional):
  --seed             Insert a dev org + project + ingest API key. In portless mode this also
                     auto-runs scripts/worktree-verify.sh (which fires sample OTLP and seeds
                     every project in pg with telemetry, so the OnboardingGate dismisses).
                     Pass --no-verify to skip the auto-verify step.
  --no-verify        Don't auto-run verify after --seed. You'll need to run
                     \`pnpm worktree:verify\` yourself, otherwise the seeded Acme/Default project
                     has zero events and OnboardingGate traps every page on the install wizard.
  --telemetry        Deprecated alias for --seed (verify now runs automatically in portless mode).

Other:
  --main-repo <path> Override path to main checkout for env symlinks (auto-detected by default)
  --skip-install     Skip `pnpm install`
  --skip-link        Skip symlinking apps/*/.env from main
  --clean-orphans    Remove Docker resources tied to deleted worktrees before starting
  --skip-gc          Skip the orphan-container check
  --help             Show this message
USAGE
}

MODE="portless"
DO_SEED=0
DO_TELEMETRY=0
SKIP_VERIFY=0
MAIN_REPO=""
SKIP_INSTALL=0
SKIP_LINK=0
SKIP_GC=0
CLEAN_ORPHANS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --shared)     MODE="shared"; shift ;;
    --isolated)   MODE="portless"; shift ;;   # legacy alias
    --portless)   MODE="portless"; shift ;;
    --seed)       DO_SEED=1; shift ;;
    --telemetry)  DO_SEED=1; DO_TELEMETRY=1; shift ;;
    --no-verify)  SKIP_VERIFY=1; shift ;;
    --main-repo)  MAIN_REPO="${2:-}"; shift 2 ;;
    --skip-install) SKIP_INSTALL=1; shift ;;
    --skip-link)  SKIP_LINK=1; shift ;;
    --clean-orphans) CLEAN_ORPHANS=1; shift ;;
    --skip-gc)    SKIP_GC=1; shift ;;
    -h|--help)    usage; exit 0 ;;
    --)           shift ;;
    *)            echo "unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done

# Worktree detection via git rather than path: works for `.claude/worktrees/…`
# (Claude Code), `conductor/workspaces/…` (Conductor), `.codex/worktrees/…`
# (Codex), or anywhere else a user puts their worktrees. `--git-common-dir`
# returns the shared `.git` dir; in the main checkout that's `<repo>/.git`, in
# a linked worktree it points at the main repo's `.git`.
GIT_COMMON_DIR="$(git -C "$REPO_ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
if [[ -z "$GIT_COMMON_DIR" ]]; then
  echo "not inside a git repo at $REPO_ROOT — bailing." >&2
  exit 1
fi

# This repo can be checked out as a git submodule, in which case the dev scripts
# run from the submodule working tree. `git submodule update` gives every
# superproject worktree its own independent submodule clone whose dir is *always*
# named the same and whose git dir lives under the superproject's
# `.git/…/modules/<submodule>`. So the worktree identity (stack name) and the
# `apps/*/.env` files belong to the superproject worktree, not this submodule —
# deriving them from this repo alone would collide across worktrees (same name
# every time) and never find the env files. Pivot to the superproject when we're a
# submodule; fall back to this repo for a normal standalone checkout.
SUPERPROJECT="$(git -C "$REPO_ROOT" rev-parse --show-superproject-working-tree 2>/dev/null || true)"
if [[ -n "$SUPERPROJECT" ]]; then
  IDENTITY_ROOT="$SUPERPROJECT"
  IDENTITY_GIT_COMMON_DIR="$(git -C "$SUPERPROJECT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
else
  IDENTITY_ROOT="$REPO_ROOT"
  IDENTITY_GIT_COMMON_DIR="$GIT_COMMON_DIR"
fi

if [[ "$IDENTITY_GIT_COMMON_DIR" == "$IDENTITY_ROOT/.git" ]]; then
  echo "not in a worktree — bootstrap is a no-op for the main checkout."
  echo "use \`docker compose up -d && overmind start -D\` directly."
  exit 0
fi

WT_NAME="$(basename "$IDENTITY_ROOT")"

if [[ -z "$MAIN_REPO" ]]; then
  if [[ -n "$SUPERPROJECT" ]]; then
    # Submodule layout: the .env files live in the superproject working-tree root.
    MAIN_REPO="$SUPERPROJECT"
  else
    # Standalone checkout — the shared `.git` dir lives inside the main checkout,
    # so its parent is the main repo root wherever the worktree was created.
    MAIN_REPO="$(dirname "$GIT_COMMON_DIR")"
  fi
fi
if [[ ! -d "$MAIN_REPO" ]]; then
  echo "main repo not found: $MAIN_REPO" >&2
  echo "pass --main-repo <path> if your checkout lives elsewhere." >&2
  exit 1
fi

echo "==> worktree:    $WT_NAME"
echo "==> main repo:   $MAIN_REPO"
echo "==> mode:        $MODE"

# -----------------------------------------------------------------------------
# 0. orphan Docker resource check
# -----------------------------------------------------------------------------
if [[ "$SKIP_GC" -eq 0 ]]; then
  if command -v docker >/dev/null 2>&1; then
    orphan_report="$(./scripts/worktree-gc.sh --list 2>/dev/null || true)"
    if [[ -n "$orphan_report" ]]; then
      echo "==> orphan check: found Docker resources tied to worktrees that no longer exist:"
      printf '%s\n' "$orphan_report" | sed 's/^/      /'
      if [[ "$CLEAN_ORPHANS" -eq 1 ]]; then
        echo "==> cleaning orphan worktree Docker resources"
        ./scripts/worktree-gc.sh --clean -y
      else
        echo "    run \`pnpm worktree:gc --clean\` to remove them. continuing anyway."
      fi
    fi
  fi
fi

# -----------------------------------------------------------------------------
# 1. install deps
# -----------------------------------------------------------------------------
if [[ "$SKIP_INSTALL" -eq 0 ]]; then
  if [[ ! -d node_modules ]]; then
    echo "==> pnpm install"
    pnpm install --frozen-lockfile
  else
    echo "==> node_modules already present (--skip-install effective)"
  fi
fi

# -----------------------------------------------------------------------------
# 2. symlink .env files from main (only ones that actually exist there)
# -----------------------------------------------------------------------------
if [[ "$SKIP_LINK" -eq 0 ]]; then
  for app in api web worker proxy; do
    src="$MAIN_REPO/apps/$app/.env"
    dst="apps/$app/.env"
    if [[ ! -f "$src" && ! -L "$src" ]]; then
      continue
    fi
    if [[ -L "$dst" ]]; then
      target="$(readlink "$dst")"
      if [[ "$target" == "$src" ]]; then
        continue
      fi
      rm "$dst"
    elif [[ -e "$dst" ]]; then
      echo "  skip apps/$app/.env — exists and is not a symlink (refusing to overwrite)"
      continue
    fi
    ln -s "$src" "$dst"
    echo "  link apps/$app/.env -> $src"
  done
fi

if [[ ! -e apps/api/.env ]]; then
  echo "==> apps/api/.env missing; writing dev-only secret fallbacks"
  # STATE_SIGNING_SECRET signs connector OAuth `state` (Cloudflare / Vercel /
  # Railway); AGENT_SECRETS_KEY encrypts integration secrets at rest. Without
  # them every connector callback 503s or dies at the encrypt step, so a fresh
  # worktree can't exercise any connect flow. Dev-only values — prod supplies
  # real ones.
  cat > apps/api/.env <<EOF
BETTER_AUTH_SECRET=${WT_NAME}-local-dev-better-auth-secret
STATE_SIGNING_SECRET=${WT_NAME}-local-dev-state-signing-secret
AGENT_SECRETS_KEY=$(openssl rand -base64 32)
EOF
fi

# The worker decrypts the same integration secrets (e.g. the Railway puller's
# tokens), so it needs the same AGENT_SECRETS_KEY the api encrypted with. Kept
# in sync on every run (not just first write) so a regenerated apps/api/.env
# can't leave the worker holding a stale key.
if [[ -e apps/api/.env ]] && grep -q '^AGENT_SECRETS_KEY=' apps/api/.env; then
  api_agent_key_line=$(grep '^AGENT_SECRETS_KEY=' apps/api/.env | head -1)
  if [[ ! -e apps/worker/.env ]]; then
    printf '%s\n' "$api_agent_key_line" > apps/worker/.env
    echo "  wrote apps/worker/.env (AGENT_SECRETS_KEY shared with api)"
  elif ! grep -qxF "$api_agent_key_line" apps/worker/.env; then
    worker_env_tmp=$(mktemp)
    grep -v '^AGENT_SECRETS_KEY=' apps/worker/.env > "$worker_env_tmp" || true
    printf '%s\n' "$api_agent_key_line" >> "$worker_env_tmp"
    cat "$worker_env_tmp" > apps/worker/.env
    rm -f "$worker_env_tmp"
    echo "  synced AGENT_SECRETS_KEY into apps/worker/.env (matched to api)"
  fi
fi

# -----------------------------------------------------------------------------
# 3. mode-specific bring-up
# -----------------------------------------------------------------------------
TMP_DIR="tmp"
mkdir -p "$TMP_DIR"
SUMMARY_FILE="$TMP_DIR/worktree.json"

if [[ "$MODE" == "shared" ]]; then
  # Generate per-worktree port offsets *and* an isolated postgres database.
  # ClickHouse stays on the shared db; data is partitioned by project_id which
  # is created during seeding.
  ./scripts/worktree-env.sh

  # Pull computed values from the file we just wrote.
  WT_DB="$(grep -E '^DATABASE_URL=' apps/api/.env.local | cut -d= -f2-)"
  if [[ -z "$WT_DB" ]]; then
    echo "expected DATABASE_URL in apps/api/.env.local after worktree-env.sh — bailing." >&2
    exit 1
  fi

  # Make sure the shared postgres is up before we try to create our db.
  if ! (cd "$MAIN_REPO" && docker compose ps postgres --format json 2>/dev/null | grep -q '"State":"running"'); then
    echo "==> starting shared infra in $MAIN_REPO (docker compose up -d)"
    (cd "$MAIN_REPO" && docker compose up -d --wait postgres clickhouse collector)
  fi

  # Create the worktree's postgres database if it doesn't already exist.
  #
  # Connect via the host-side DATABASE_URL (parsed from the env file) instead of
  # `docker compose exec`. With orphan containers from removed worktrees still
  # holding the shared host port, `docker exec` and `localhost:5434` can reach
  # different postgres backends — the CREATE lands in one and the migration
  # tries the other. Always going through DATABASE_URL keeps them aligned.
  WT_DB_NAME="$(printf '%s' "$WT_DB" | sed -E 's|^.*/||; s|\?.*$||')"
  echo "==> ensuring postgres database: $WT_DB_NAME"
  pnpm --silent exec tsx scripts/ensure-database.ts "$WT_DB"

  echo "==> running migrations against $WT_DB_NAME"
  DATABASE_URL="$WT_DB" pnpm --filter @superlog/db db:migrate

  WEB_PORT="$(grep -E '^WEB_PORT=' apps/web/.env.local | cut -d= -f2-)"
  API_PORT="$(grep -E '^PORT=' apps/api/.env.local | cut -d= -f2-)"
  PROXY_PORT="$(grep -E '^PORT=' apps/proxy/.env.local | cut -d= -f2-)"
  WEB_URL="http://localhost:${WEB_PORT}"
  API_URL="http://localhost:${API_PORT}"
  PROXY_URL="http://localhost:${PROXY_PORT}"

  cat > "$SUMMARY_FILE" <<JSON
{
  "mode": "shared",
  "worktree": "$WT_NAME",
  "database_url": "$WT_DB",
  "database_name": "$WT_DB_NAME",
  "web_url": "$WEB_URL",
  "api_url": "$API_URL",
  "proxy_url": "$PROXY_URL",
  "boot": "overmind start -D"
}
JSON

else
  # isolated / portless
  echo "==> starting portless stack"
  ./scripts/portless-stack.sh start --name "$WT_NAME"

  STACK_DIR="$REPO_ROOT/tmp/portless-stacks/$WT_NAME"
  ENV_FILE="$STACK_DIR/env"
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "expected env file at $ENV_FILE after portless start — bailing." >&2
    exit 1
  fi

  # shellcheck disable=SC1090
  source "$ENV_FILE"

  cat > "$SUMMARY_FILE" <<JSON
{
  "mode": "portless",
  "worktree": "$WT_NAME",
  "database_url": "$DATABASE_URL",
  "clickhouse_url": "$CLICKHOUSE_URL",
  "web_url": "$SUPERLOG_PORTLESS_WEB_URL",
  "api_url": "$SUPERLOG_PORTLESS_API_URL",
  "proxy_url": "$SUPERLOG_PORTLESS_PROXY_URL",
  "stack_env_file": "$ENV_FILE",
  "boot": "already running via portless-stack.sh"
}
JSON
fi

# -----------------------------------------------------------------------------
# 4. seeding (optional) — DB-only. Telemetry test waits until after overmind.
# -----------------------------------------------------------------------------
if [[ "$DO_SEED" -eq 1 ]]; then
  echo "==> seeding org / project / api key"
  ./scripts/worktree-seed.sh
fi

echo
echo "summary written to $SUMMARY_FILE:"
cat "$SUMMARY_FILE"
echo

# Default behavior: if --seed ran and services are up (portless), run verify.
# Verify fires sample OTLP into the seeded Acme project AND walks every
# project in pg to mint a key + seed telemetry — so the personal org Better
# Auth creates on the first sign-up gets unstuck too.
AUTO_VERIFY=0
if [[ "$DO_SEED" -eq 1 && "$SKIP_VERIFY" -eq 0 ]]; then
  if [[ "$MODE" == "portless" ]]; then
    AUTO_VERIFY=1
  elif [[ "$DO_TELEMETRY" -eq 1 ]]; then
    AUTO_VERIFY=1
  fi
fi

case "$MODE" in
  shared)
    if [[ "$AUTO_VERIFY" -eq 1 ]]; then
      echo "==> --telemetry: starting overmind first, then running verify"
      overmind start -D >/dev/null 2>&1 || true
    else
      echo "next: overmind start -D"
      echo "      then: pnpm worktree:verify    # fires sample OTLP into every project so OnboardingGate dismisses"
    fi
    ;;
  portless)
    if [[ "$AUTO_VERIFY" -eq 1 ]]; then
      echo "==> services already running via portless. tail logs at $STACK_DIR/logs/"
    else
      echo "next: services already running via portless. tail logs at $STACK_DIR/logs/"
      echo "      then: pnpm worktree:verify    # fires sample OTLP into every project so OnboardingGate dismisses"
    fi
    ;;
esac

if [[ "$AUTO_VERIFY" -eq 1 ]]; then
  echo
  ./scripts/worktree-verify.sh || echo "verify failed — services may still be warming up; re-run \`pnpm worktree:verify\`."
fi
