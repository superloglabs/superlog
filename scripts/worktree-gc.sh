#!/usr/bin/env bash
#
# Find docker resources from worktrees that no longer exist on disk and (with
# --clean) remove them. This is the antidote to "I deleted my branch but
# docker still has 3 containers + a 200MB pg volume from it".
#
# What counts as orphan:
#   1. `superlog-portless-<name>-*` containers / volumes / networks where
#      <name> is not in `git worktree list`.
#   2. Compose projects under `.claude/worktrees/<name>/docker-compose.yml`
#      where the worktree directory was removed. We detect these via
#      docker labels (com.docker.compose.project.working_dir).
#
# Usage:
#   scripts/worktree-gc.sh             # report only (used by bootstrap)
#   scripts/worktree-gc.sh --list      # one orphan name per line, machine-readable
#   scripts/worktree-gc.sh --clean     # docker rm -f + volume rm; idempotent
#   scripts/worktree-gc.sh --clean -y  # skip confirmation prompt

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

MODE="report"
ASSUME_YES=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --list)   MODE="list"; shift ;;
    --clean)  MODE="clean"; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

if ! command -v docker >/dev/null 2>&1; then
  [[ "$MODE" == "list" ]] && exit 0
  echo "docker not on PATH — nothing to do" >&2
  exit 0
fi

# Live worktree names. Worktrees can live under `.claude/worktrees`,
# `~/conductor/workspaces`, `.codex/worktrees`, or any other path. Keep both
# the raw directory basename (for compose working_dir labels) and the slugified
# portless stack name (for `superlog-portless-<name>` resources).
LIVE_NAMES="$(
  git worktree list --porcelain 2>/dev/null \
    | awk '
      /^worktree / {
        path = substr($0, 10)
        sub(/\/$/, "", path)
        n = split(path, parts, "/")
        if (n > 0 && parts[n] != "") {
          raw = parts[n]
          print raw
          name = tolower(raw)
          gsub(/[^a-z0-9-]+/, "-", name)
          gsub(/^-+/, "", name)
          gsub(/-+$/, "", name)
          while (gsub(/--+/, "-", name)) {}
          if (name == "") name = "stack"
          print name
        }
      }
    ' \
    | sort -u
)"

is_live() {
  local name="$1"
  [[ -z "$name" ]] && return 0
  printf '%s\n' "$LIVE_NAMES" | grep -qxF "$name"
}

# A docker resource may be tied to a worktree two ways:
#   - portless: `superlog-portless-<name>-<svc>-N` (compose-project naming)
#   - per-worktree compose: working_dir label points at .claude/worktrees/<name>
#
# We unify them into a list of orphan compose projects, then expand to
# containers / volumes / networks.

orphan_projects=()

# (a) portless projects via container-name pattern.
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  project="$(printf '%s\n' "$line" | sed -E 's/-[^-]+-[0-9]+$//')"
  # project = superlog-portless-<name>
  if [[ "$project" =~ ^superlog-portless-(.+)$ ]]; then
    name="${BASH_REMATCH[1]}"
    if ! is_live "$name"; then
      orphan_projects+=("$project|$name")
    fi
  fi
done < <(docker ps -a --filter 'name=^superlog-portless-' --format '{{.Names}}' | sort -u)

# (b) portless projects via network name. This catches stale Docker networks
# after containers are already gone, which can exhaust Docker's address pools.
while IFS= read -r network; do
  [[ -z "$network" ]] && continue
  if [[ "$network" =~ ^(superlog-portless-(.+))_default$ ]]; then
    project="${BASH_REMATCH[1]}"
    name="${BASH_REMATCH[2]}"
    if ! is_live "$name"; then
      orphan_projects+=("$project|$name")
    fi
  fi
done < <(docker network ls --format '{{.Name}}' | sort -u)

# (c) per-worktree compose stacks via label.
while IFS=$'\t' read -r project working_dir; do
  [[ -z "$project" ]] && continue
  if [[ "$working_dir" =~ /\.claude/worktrees/([^/]+) ]]; then
    name="${BASH_REMATCH[1]}"
    if ! is_live "$name"; then
      orphan_projects+=("$project|$name")
    fi
  fi
done < <(
  docker ps -a --format '{{.Label "com.docker.compose.project"}}	{{.Label "com.docker.compose.project.working_dir"}}' \
    | sort -u
)

# Dedup
orphan_projects_sorted="$(printf '%s\n' "${orphan_projects[@]:-}" | awk 'NF' | sort -u)"

if [[ "$MODE" == "list" ]]; then
  if [[ -n "$orphan_projects_sorted" ]]; then
    printf '%s\n' "$orphan_projects_sorted" | awk -F'|' 'NF {printf "%-50s (worktree: %s)\n", $1, $2}'
  fi
  exit 0
fi

if [[ -z "$orphan_projects_sorted" ]]; then
  echo "no orphan worktree Docker resources found."
  exit 0
fi

echo "orphan compose projects:"
printf '%s\n' "$orphan_projects_sorted" | awk -F'|' 'NF {printf "  %-50s (worktree: %s)\n", $1, $2}'

if [[ "$MODE" != "clean" ]]; then
  echo
  echo "run with --clean to remove them (docker compose down -v + network rm)."
  exit 0
fi

if [[ "$ASSUME_YES" -ne 1 ]]; then
  echo
  printf 'remove all the above? [y/N] '
  read -r ans
  case "$ans" in
    y|Y|yes|YES) ;;
    *) echo "aborted."; exit 1 ;;
  esac
fi

while IFS='|' read -r project _; do
  [[ -z "$project" ]] && continue
  echo "==> docker compose -p $project down -v --remove-orphans"
  docker compose -p "$project" down -v --remove-orphans 2>/dev/null || \
    docker rm -f $(docker ps -a --filter "label=com.docker.compose.project=$project" -q) 2>/dev/null || true
  docker network rm "${project}_default" >/dev/null 2>&1 || true
done <<< "$orphan_projects_sorted"

echo "done."
