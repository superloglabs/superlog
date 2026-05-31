#!/usr/bin/env bash
#
# End-to-end smoke test for a worktree stack. Run AFTER overmind / portless
# has services up. Confirms:
#   - web responds 200
#   - api responds 200
#   - proxy accepts an OTLP trace with the seeded ingest key
#   - the trace lands in this worktree's ClickHouse (portless) or the shared
#     ClickHouse with the right project_id (shared)
#
# Reads tmp/worktree.json + tmp/worktree-seed.json. Run worktree:bootstrap
# with --seed first if no seed file exists.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

SUMMARY="tmp/worktree.json"
SEED="tmp/worktree-seed.json"

if [[ ! -f "$SUMMARY" ]]; then
  echo "$SUMMARY missing — run \`pnpm worktree:bootstrap --seed\` first." >&2
  exit 1
fi
if [[ ! -f "$SEED" ]]; then
  echo "$SEED missing — run \`pnpm worktree:bootstrap --seed\` first." >&2
  exit 1
fi

WEB_URL="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("'"$SUMMARY"'","utf8")).web_url)')"
API_URL="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("'"$SUMMARY"'","utf8")).api_url)')"
PROXY_URL="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("'"$SUMMARY"'","utf8")).proxy_url)')"
INGEST_KEY="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("'"$SEED"'","utf8")).ingest_api_key)')"

# Portless URLs may need the local CA in the trust store.
CA_ARG=""
if [[ "$PROXY_URL" == https* ]] && [[ -f "$HOME/.portless/ca.pem" ]]; then
  CA_ARG="--cacert $HOME/.portless/ca.pem"
fi

check_http() {
  local label="$1" url="$2" expected="${3:-200}"
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' $CA_ARG "$url" || echo 000)"
  if [[ "$code" == "$expected" ]]; then
    echo "  ok    $label  $url  → $code"
  else
    echo "  FAIL  $label  $url  → $code (expected $expected)"
    return 1
  fi
}

# Poll because services come up async.
poll() {
  local label="$1" url="$2" expected="${3:-200}" attempts="${4:-20}"
  for i in $(seq 1 "$attempts"); do
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' $CA_ARG "$url" || echo 000)"
    if [[ "$code" == "$expected" ]]; then
      echo "  ok    $label  $url  → $code"
      return 0
    fi
    sleep 1
  done
  echo "  FAIL  $label  $url  → $code (expected $expected after $attempts attempts)"
  return 1
}

echo "==> http health"
poll "web    " "$WEB_URL/"
poll "api    " "$API_URL/health"
# Proxy has no health route — a GET on / returns 404. We just want connection.
poll "proxy  " "$PROXY_URL/" 404 || true

# A 200 from the web URL above can mean two very different things:
#  (a) Vite served the app (good)
#  (b) ~/.portless/routes.json is corrupted and the portless landing page
#      is serving a "No app registered for <name>.superlog.localhost" page
#      with status 200 (bad — looks healthy but the app is unreachable).
# Detect (b) by sniffing the response body for the portless landing copy.
WEB_BODY="$(curl -sk $CA_ARG "$WEB_URL/" 2>/dev/null || true)"
if [[ "$WEB_BODY" == *"No app registered"* ]]; then
  echo "  FAIL  portless has no route for $WEB_URL — ~/.portless/routes.json likely corrupted"
  echo "        recover: cat ~/.portless/routes.json (should be valid JSON)."
  echo "                 If empty/invalid: echo '[]' > ~/.portless/routes.json"
  echo "                 then: scripts/portless-stack.sh stop --name <worktree>"
  echo "                       scripts/portless-stack.sh start --name <worktree>"
  exit 1
fi

API_HEALTH_BODY="$(curl -sk $CA_ARG "$API_URL/health" 2>/dev/null || true)"
if [[ "$API_HEALTH_BODY" != *'"ok":true'* ]]; then
  echo "  FAIL  api health did not return JSON from the API service"
  echo "        url: $API_URL/health"
  echo "        body preview: ${API_HEALTH_BODY:0:120}"
  echo "        recover: scripts/portless-stack.sh stop --name <worktree>"
  echo "                 scripts/portless-stack.sh start --name <worktree>"
  exit 1
fi

echo
echo "==> firing sample OTLP trace through proxy"
TRACE_ID="$(node -e 'console.log(require("crypto").randomBytes(16).toString("hex"))')"
SPAN_ID="$(node -e 'console.log(require("crypto").randomBytes(8).toString("hex"))')"
NOW_NS="$(node -e 'console.log(BigInt(Date.now()) * 1000000n + "")')"
END_NS="$(node -e 'console.log((BigInt(Date.now()) + 1n) * 1000000n + "")')"

PAYLOAD="$(cat <<JSON
{
  "resourceSpans": [{
    "resource": {"attributes":[{"key":"service.name","value":{"stringValue":"verify-svc"}}]},
    "scopeSpans": [{
      "scope": {"name":"verify"},
      "spans": [{
        "traceId": "$TRACE_ID",
        "spanId": "$SPAN_ID",
        "name": "verify-span",
        "kind": 1,
        "startTimeUnixNano": "$NOW_NS",
        "endTimeUnixNano": "$END_NS",
        "status": {"code": 1}
      }]
    }]
  }]
}
JSON
)"

resp="$(curl -s $CA_ARG -X POST "$PROXY_URL/v1/traces" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $INGEST_KEY" \
  -w '\n__HTTP__%{http_code}' \
  -d "$PAYLOAD")"
status="${resp##*__HTTP__}"
body="${resp%__HTTP__*}"

if [[ "$status" != "200" ]]; then
  echo "  FAIL  proxy returned $status: $body"
  exit 1
fi
echo "  ok    proxy returned 200  trace_id=$TRACE_ID"

echo
echo "==> waiting for trace to land in ClickHouse"
# Both modes write to ClickHouse DB `superlog` (CLICKHOUSE_DB=superlog in
# docker-compose.yml and portless env). Portless puts the URL in worktree.json
# on a unique host port; shared mode uses 8123.
CH_URL="$(node -e '
  const j = JSON.parse(require("fs").readFileSync("'"$SUMMARY"'","utf8"));
  console.log(j.clickhouse_url || "http://localhost:8123");
')"
CH_DB="${CLICKHOUSE_DB:-superlog}"

found=0
for i in $(seq 1 15); do
  count="$(curl -s "$CH_URL/?database=$CH_DB" --data-binary "SELECT count(*) FROM otel_traces WHERE TraceId = '$TRACE_ID' FORMAT TabSeparated" 2>/dev/null || echo 0)"
  if [[ "$count" =~ ^[0-9]+$ ]] && [[ "$count" -gt 0 ]]; then
    echo "  ok    trace found in ClickHouse ($count row(s)) in db=$CH_DB"
    found=1
    break
  fi
  sleep 1
done

if [[ "$found" -eq 0 ]]; then
  echo "  FAIL  trace did not land in ClickHouse within 15s (queried $CH_URL/?database=$CH_DB)"
  echo "        check collector logs: docker logs \$(docker ps --filter name=collector --format '{{.Names}}' | head -1)"
  exit 1
fi

echo
echo "==> seeding sample logs / metrics / traces (so the metrics explorer has data)"
NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-$HOME/.portless/ca.pem}" \
  pnpm --silent exec tsx scripts/demo/seed-acme-telemetry.ts \
    --ingest-url "$PROXY_URL" \
    --api-key "$INGEST_KEY" \
  | node -e '
    let s = ""; process.stdin.on("data", c => s += c).on("end", () => {
      const m = s.match(/\{[\s\S]*\}/);
      if (!m) { process.stderr.write(s); process.exit(0); }
      const j = JSON.parse(m[0]);
      const points = j.metricDataPoints ?? j.metrics ?? 0;
      const window = j.seriesWindowMinutes
        ? ", " + j.seriesWindowMinutes + "m window @ " + j.seriesIntervalSeconds + "s steps"
        : "";
      console.log("  ok    seeded "
        + j.seededServices.length + " service(s), "
        + j.logRecords + " log record(s), "
        + points + " metric data point(s)" + window);
    });
  '

echo
echo "==> ensuring canonical test user (test@test.com / adminadmin) exists"
# Run BEFORE ensure-telemetry so the test user's auto-created personal org is
# in pg by the time we seed telemetry — otherwise its Default project starts
# empty and OnboardingGate traps the test user on the install wizard until
# the NEXT verify pass.
bash scripts/worktree-ensure-test-user.sh

echo
echo "==> ensuring every project in pg has telemetry (unsticks OnboardingGate for fresh orgs incl. the test user's)"
NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-$HOME/.portless/ca.pem}" \
  pnpm --silent exec tsx scripts/worktree-ensure-telemetry.ts

echo
echo "verify: all checks passed."
echo "  web:    $WEB_URL"
echo "  api:    $API_URL"
echo "  proxy:  $PROXY_URL"
echo "  signin: test@test.com / adminadmin"
