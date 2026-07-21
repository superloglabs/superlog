import assert from "node:assert/strict";
import { test } from "node:test";
import {
  candidateIssues,
  candidateMatchesFilters,
  endpointHostsFromText,
  endpointKind,
  environmentForResourceAttrs,
  type GroupingCandidateIncident,
  parseDecisionToolInput,
  parseListFilters,
  parseSearchInput,
  parseVerdictFromText,
  tokenize,
  uniqueSorted,
} from "./domain.js";

function makeCandidate(overrides: Partial<GroupingCandidateIncident> = {}): GroupingCandidateIncident {
  return {
    id: "inc-1",
    title: "Connection refused",
    service: "api",
    firstSeen: "2026-05-22T00:00:00Z",
    lastSeen: "2026-05-23T00:00:00Z",
    issueCount: 2,
    representative: {
      exceptionType: "ECONNREFUSED",
      message: "Connection refused localhost:5432",
      topFrame: "db.query",
      normalizedFrames: ["db.query", "pool.acquire"],
      traceId: "abc",
      spanId: "def",
      resourceAttrs: { "deployment.environment": "production", "service.name": "api" },
    },
    ...overrides,
  };
}

test("environmentForResourceAttrs prefers deployment.environment, falls back to .name then environment", () => {
  assert.equal(environmentForResourceAttrs({ "deployment.environment": "prod" }), "prod");
  assert.equal(
    environmentForResourceAttrs({ "deployment.environment.name": "staging" }),
    "staging",
  );
  assert.equal(environmentForResourceAttrs({ environment: "dev" }), "dev");
  assert.equal(environmentForResourceAttrs({ unrelated: "x" }), null);
  assert.equal(environmentForResourceAttrs(null), null);
  assert.equal(environmentForResourceAttrs(undefined), null);
});

test("candidateIssues synthesises a single issue from the representative when issues array is empty", () => {
  const candidate = makeCandidate();
  const issues = candidateIssues(candidate);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.id, "inc-1:representative");
  assert.equal(issues[0]?.exceptionType, "ECONNREFUSED");
});

test("candidateIssues returns the explicit issues array when provided", () => {
  const candidate = makeCandidate({
    issues: [
      {
        id: "iss-1",
        title: "t1",
        service: "api",
        exceptionType: "Boom",
        message: null,
        topFrame: null,
        normalizedFrames: [],
        traceId: null,
        spanId: null,
        lastSeen: "2026-05-23T00:00:00Z",
      },
    ],
  });
  const issues = candidateIssues(candidate);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.id, "iss-1");
});

test("uniqueSorted dedupes and drops nullish values", () => {
  assert.deepEqual(uniqueSorted(["a", "b", null, "a", undefined, "c"]), ["a", "b", "c"]);
});

test("tokenize lowercases, splits, keeps tokens >=2 chars", () => {
  assert.deepEqual(tokenize("Hello, World! a 12 ECONNREFUSED"), [
    "hello",
    "world",
    "12",
    "econnrefused",
  ]);
});

test("endpointHostsFromText finds localhost / railway.internal / .localhost forms", () => {
  const text = "GET http://localhost:5173/ failed; tried api.railway.internal:4100 and worker.localhost";
  const hosts = endpointHostsFromText(text);
  assert.ok(hosts.includes("localhost:5173"));
  assert.ok(hosts.includes("api.railway.internal:4100"));
  assert.ok(hosts.includes("worker.localhost"));
});

test("endpointKind classifies hosts", () => {
  assert.equal(endpointKind("localhost:5173"), "localhost");
  assert.equal(endpointKind("127.0.0.1"), "localhost");
  assert.equal(endpointKind("worktree.localhost"), "localhost");
  assert.equal(endpointKind("api.railway.internal"), "railway_internal");
  assert.equal(endpointKind("example.com"), "other");
});

test("candidateMatchesFilters checks service against candidate + linked issues", () => {
  const candidate = makeCandidate();
  assert.equal(
    candidateMatchesFilters(candidate, { service: "api", environment: null }),
    true,
  );
  assert.equal(
    candidateMatchesFilters(candidate, { service: "billing", environment: null }),
    false,
  );
});

test("candidateMatchesFilters checks environment against representative + issues", () => {
  const candidate = makeCandidate();
  assert.equal(
    candidateMatchesFilters(candidate, { service: null, environment: "production" }),
    true,
  );
  assert.equal(
    candidateMatchesFilters(candidate, { service: null, environment: "staging" }),
    false,
  );
});

test("parseListFilters clamps limit and trims string filters", () => {
  assert.deepEqual(parseListFilters({}), { service: null, environment: null, limit: 200 });
  assert.deepEqual(parseListFilters({ service: "  api  ", limit: 5 }), {
    service: "api",
    environment: null,
    limit: 5,
  });
  assert.deepEqual(parseListFilters({ limit: 999 }), {
    service: null,
    environment: null,
    limit: 200,
  });
  assert.deepEqual(parseListFilters({ limit: -1 }), {
    service: null,
    environment: null,
    limit: 1,
  });
});

test("parseSearchInput tokenises the query and clamps the limit", () => {
  const out = parseSearchInput({ query: "ClickHouse ECONNRESET", limit: 100 });
  assert.equal(out.query, "ClickHouse ECONNRESET");
  assert.deepEqual(out.tokens, ["clickhouse", "econnreset"]);
  assert.equal(out.limit, 25);
});

test("parseVerdictFromText returns null when the reply is not a verdict", () => {
  const ids = new Set(["a", "b"]);
  assert.equal(parseVerdictFromText("not json", ids), null);
  assert.equal(parseVerdictFromText("\"string\"", ids), null);
  assert.equal(parseVerdictFromText("{\"foo\": 1}", ids), null);
});

test("parseVerdictFromText honours a valid standalone without evidence", () => {
  const ids = new Set(["a", "b"]);
  assert.deepEqual(parseVerdictFromText("{\"decision\": \"standalone\"}", ids), {
    decision: "standalone",
    evidence: null,
  });
});

test("parseVerdictFromText accepts join only with known id AND >=20 chars evidence", () => {
  const ids = new Set(["inc-1"]);
  assert.deepEqual(
    parseVerdictFromText(
      JSON.stringify({ decision: "join", incidentId: "inc-1", evidence: "x".repeat(25) }),
      ids,
    ),
    { decision: "join", incidentId: "inc-1", evidence: "x".repeat(25) },
  );
  // Unknown id → standalone
  assert.deepEqual(
    parseVerdictFromText(
      JSON.stringify({
        decision: "join",
        incidentId: "unknown",
        evidence: "y".repeat(25),
      }),
      ids,
    ),
    { decision: "standalone", evidence: null },
  );
  // Too-short evidence → standalone
  assert.deepEqual(
    parseVerdictFromText(
      JSON.stringify({ decision: "join", incidentId: "inc-1", evidence: "short" }),
      ids,
    ),
    { decision: "standalone", evidence: null },
  );
});

test("parseDecisionToolInput rejects non-object inputs", () => {
  assert.equal(parseDecisionToolInput(null, new Set()), null);
  assert.equal(parseDecisionToolInput("hi", new Set()), null);
});

test("parseDecisionToolInput accepts standalone with optional evidence", () => {
  const ids = new Set(["inc-1"]);
  assert.deepEqual(parseDecisionToolInput({ decision: "standalone" }, ids), {
    decision: "standalone",
    evidence: null,
  });
  assert.deepEqual(
    parseDecisionToolInput({ decision: "standalone", evidence: "  unrelated  " }, ids),
    { decision: "standalone", evidence: "unrelated" },
  );
});

test("parseDecisionToolInput accepts join only with known id AND sufficient evidence", () => {
  const ids = new Set(["inc-1"]);
  assert.deepEqual(
    parseDecisionToolInput(
      { decision: "join", incidentId: "inc-1", evidence: "shared root cause matched on stack" },
      ids,
    ),
    {
      decision: "join",
      incidentId: "inc-1",
      evidence: "shared root cause matched on stack",
    },
  );
  // Unknown id
  assert.deepEqual(
    parseDecisionToolInput(
      { decision: "join", incidentId: "ghost", evidence: "x".repeat(30) },
      ids,
    ),
    { decision: "standalone", evidence: null },
  );
});

test("parseDecisionToolInput returns null on unknown decision value (so the loop retries)", () => {
  assert.equal(
    parseDecisionToolInput({ decision: "maybe" }, new Set(["inc-1"])),
    null,
  );
});
