#!/usr/bin/env bash
#
# Seed a worktree's database with a dev Acme org / Default project / ingest
# API key. The defaults (Acme / acme / Default / default) are convenient for
# poking at the API directly with a known-good ingest key — a freshly
# signed-up user lands in their own personal org created by the
# `user.create.after` hook in apps/api/src/auth.ts, not Acme. The per-project
# telemetry sweep in scripts/worktree-verify.sh covers both.
#
# Override any of the defaults via flags below.
#
# Reads tmp/worktree.json (written by worktree-bootstrap.sh) for the worktree
# mode, DB URL, and proxy URL. Telemetry now lives in scripts/worktree-verify.sh.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

DO_TELEMETRY=0  # deprecated — telemetry now lives in scripts/worktree-verify.sh
OWNER_EMAIL=""
ORG_NAME="Acme"
ORG_SLUG="acme"
PROJECT_NAME="Default"
PROJECT_SLUG="default"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --telemetry)    DO_TELEMETRY=1; shift ;;
    --owner-email)  OWNER_EMAIL="${2:-}"; shift 2 ;;
    --org-name)     ORG_NAME="${2:-}"; shift 2 ;;
    --org-slug)     ORG_SLUG="${2:-}"; shift 2 ;;
    --project-name) PROJECT_NAME="${2:-}"; shift 2 ;;
    --project-slug) PROJECT_SLUG="${2:-}"; shift 2 ;;
    -h|--help)
      cat <<'USAGE'
Usage: scripts/worktree-seed.sh [options]

  --owner-email <email>  Owner email (default: git config user.email or dev@superlog.local)
  --org-name <name>      Default: Acme
  --org-slug <slug>      Default: acme
  --project-name <name>  Default: Default
  --project-slug <slug>  Default: default
USAGE
      exit 0
      ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

SUMMARY_FILE="tmp/worktree.json"
if [[ ! -f "$SUMMARY_FILE" ]]; then
  echo "$SUMMARY_FILE missing — run pnpm worktree:bootstrap first." >&2
  exit 1
fi

WT_NAME="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("'"$SUMMARY_FILE"'","utf8")).worktree)')"
MODE="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("'"$SUMMARY_FILE"'","utf8")).mode)')"
DATABASE_URL_VAL="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("'"$SUMMARY_FILE"'","utf8")).database_url)')"
PROXY_URL="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("'"$SUMMARY_FILE"'","utf8")).proxy_url)')"

if [[ -z "$OWNER_EMAIL" ]]; then
  OWNER_EMAIL="$(git config user.email 2>/dev/null || true)"
  : "${OWNER_EMAIL:=dev@superlog.local}"
fi

KEY_NAME="${WT_NAME}-ingest"

echo "==> seeding into $MODE mode db ($DATABASE_URL_VAL)"
echo "    owner-email:  $OWNER_EMAIL"
echo "    org-slug:     $ORG_SLUG"
echo "    project-slug: $PROJECT_SLUG"
echo "    key-name:     $KEY_NAME"

BOOTSTRAP_OUT="$(
  DATABASE_URL="$DATABASE_URL_VAL" \
    pnpm --silent exec tsx scripts/demo/bootstrap-acme.ts \
      --target "worktree-$WT_NAME" \
      --owner-email "$OWNER_EMAIL" \
      --org-name "$ORG_NAME" \
      --org-slug "$ORG_SLUG" \
      --project-name "$PROJECT_NAME" \
      --project-slug "$PROJECT_SLUG" \
      --key-name "$KEY_NAME"
)"

INGEST_KEY="$(printf '%s' "$BOOTSTRAP_OUT" | node -e '
  let s = ""; process.stdin.on("data", c => s += c).on("end", () => {
    const m = s.match(/\{[\s\S]*\}/); if (!m) { process.exit(1); }
    const j = JSON.parse(m[0]); console.log(j.ingestApiKey.plaintext);
  });
')"

if [[ -z "$INGEST_KEY" ]]; then
  echo "could not parse ingest key from bootstrap output:" >&2
  echo "$BOOTSTRAP_OUT" >&2
  exit 1
fi

SEED_FILE="tmp/worktree-seed.json"
cat > "$SEED_FILE" <<JSON
{
  "owner_email": "$OWNER_EMAIL",
  "org_slug": "$ORG_SLUG",
  "project_slug": "$PROJECT_SLUG",
  "ingest_api_key": "$INGEST_KEY",
  "proxy_url": "$PROXY_URL"
}
JSON

echo "    ingest key:   $INGEST_KEY"
echo "    seed file:    $SEED_FILE"

if [[ "$DO_TELEMETRY" -eq 1 ]]; then
  echo "==> --telemetry on seed is deprecated; run \`pnpm worktree:verify\` after services are up." >&2
fi
