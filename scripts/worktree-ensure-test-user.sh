#!/usr/bin/env bash
#
# Ensure the canonical worktree test account exists:
#   email:    test@test.com
#   password: adminadmin
#
# Idempotent: POSTs Better Auth's sign-up endpoint. 200 means "created";
# 422 with USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL means "already there",
# then signs in with the canonical password. Anything else fails loud.
#
# This account exists so any agent (or human) can sign in to a fresh
# worktree without having to invent credentials. If the account has no org
# yet, this script calls /api/me/orgs to create a personal org + Default
# project for the test user.
#
# IMPORTANT: worktree-verify.sh runs this BEFORE worktree-ensure-telemetry.ts,
# so on the very first verify pass the test user's brand-new project gets
# telemetry seeded into it. Otherwise OnboardingGate traps the test user on
# the install wizard until the user thinks to re-run verify. Don't reorder
# these two steps.
#
# Reads tmp/worktree.json for the API URL. Run after `pnpm worktree:verify`'s
# http-health checks have confirmed the api is up.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

SUMMARY="tmp/worktree.json"
if [[ ! -f "$SUMMARY" ]]; then
  echo "$SUMMARY missing — run \`pnpm worktree:bootstrap --seed\` first." >&2
  exit 1
fi

API_URL="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("'"$SUMMARY"'","utf8")).api_url)')"
WEB_URL="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("'"$SUMMARY"'","utf8")).web_url)')"

CA_ARG=""
if [[ "$API_URL" == https* ]] && [[ -f "$HOME/.portless/ca.pem" ]]; then
  CA_ARG="--cacert $HOME/.portless/ca.pem"
fi

EMAIL="test@test.com"
PASSWORD="adminadmin"
NAME="Test User"
COOKIE_JAR="$(mktemp)"
trap 'rm -f "$COOKIE_JAR"' EXIT

resp="$(curl -s $CA_ARG -c "$COOKIE_JAR" -X POST "$API_URL/api/auth/sign-up/email" \
  -H 'content-type: application/json' \
  -H "origin: $WEB_URL" \
  -w '\n__HTTP__%{http_code}' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"name\":\"$NAME\"}")"
status="${resp##*__HTTP__}"
body="${resp%__HTTP__*}"

case "$status" in
  200|201)
    echo "  ok    created test user  $EMAIL / $PASSWORD"
    ;;
  422)
    if [[ "$body" == *"USER_ALREADY_EXISTS"* ]]; then
      echo "  skip  test user $EMAIL already exists"
      signin_resp="$(curl -s $CA_ARG -c "$COOKIE_JAR" -X POST "$API_URL/api/auth/sign-in/email" \
        -H 'content-type: application/json' \
        -H "origin: $WEB_URL" \
        -w '\n__HTTP__%{http_code}' \
        -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")"
      signin_status="${signin_resp##*__HTTP__}"
      signin_body="${signin_resp%__HTTP__*}"
      if [[ "$signin_status" != "200" ]]; then
        echo "  FAIL  sign-in returned $signin_status: $signin_body" >&2
        exit 1
      fi
    else
      echo "  FAIL  sign-up returned 422 with unexpected body: $body" >&2
      exit 1
    fi
    ;;
  *)
    echo "  FAIL  sign-up returned $status: $body" >&2
    exit 1
    ;;
esac

me_resp="$(curl -s $CA_ARG -b "$COOKIE_JAR" "$API_URL/api/me" -w '\n__HTTP__%{http_code}')"
me_status="${me_resp##*__HTTP__}"
me_body="${me_resp%__HTTP__*}"
if [[ "$me_status" != "200" ]]; then
  echo "  FAIL  /api/me returned $me_status: $me_body" >&2
  exit 1
fi

project_id="$(BODY="$me_body" node -e 'const body = JSON.parse(process.env.BODY); console.log(body.project?.id ?? "")')"
if [[ -n "$project_id" ]]; then
  echo "  ok    test user has project context"
  exit 0
fi

org_resp="$(curl -s $CA_ARG -b "$COOKIE_JAR" -X POST "$API_URL/api/me/orgs" \
  -H 'content-type: application/json' \
  -H "origin: $WEB_URL" \
  -w '\n__HTTP__%{http_code}' \
  -d '{"name":"Test User'\''s org"}')"
org_status="${org_resp##*__HTTP__}"
org_body="${org_resp%__HTTP__*}"
if [[ "$org_status" != "200" ]]; then
  echo "  FAIL  create test org returned $org_status: $org_body" >&2
  exit 1
fi

created_project_id="$(BODY="$org_body" node -e 'const body = JSON.parse(process.env.BODY); console.log(body.project?.id ?? "")')"
if [[ -z "$created_project_id" ]]; then
  echo "  FAIL  create test org response had no project: $org_body" >&2
  exit 1
fi
echo "  ok    created test org/project for $EMAIL"
