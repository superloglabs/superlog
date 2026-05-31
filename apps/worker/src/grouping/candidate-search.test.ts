import assert from "node:assert/strict";
import { test } from "node:test";
import {
  candidatePreview,
  inspectCandidate,
  listIncidentFacets,
  listIncidentTitles,
  searchCandidates,
} from "./candidate-search.js";
import type { GroupingCandidateIncident } from "./domain.js";

function makeCandidate(overrides: Partial<GroupingCandidateIncident> = {}): GroupingCandidateIncident {
  return {
    id: "inc-1",
    title: "DB unreachable",
    service: "api",
    firstSeen: "2026-05-22T00:00:00Z",
    lastSeen: "2026-05-23T00:00:00Z",
    issueCount: 1,
    representative: {
      exceptionType: "ECONNREFUSED",
      message: "connect ECONNREFUSED localhost:5432",
      topFrame: "db.query",
      normalizedFrames: ["db.query"],
      traceId: "t1",
      spanId: "s1",
      resourceAttrs: { "deployment.environment": "production" },
    },
    ...overrides,
  };
}

test("candidatePreview includes services, environments, latestInvestigation summary", () => {
  const candidate = makeCandidate({
    investigation: {
      id: "inv-1",
      state: "complete",
      createdAt: "2026-05-22T00:00:00Z",
      completedAt: "2026-05-22T01:00:00Z",
      selectedRepoFullName: "org/repo",
      result: null,
    },
  });
  const preview = candidatePreview(candidate);
  assert.deepEqual(preview.services, ["api"]);
  assert.deepEqual(preview.environments, ["production"]);
  assert.equal(preview.linkedIssueCount, 1);
  assert.deepEqual(preview.latestInvestigation, {
    state: "complete",
    completedAt: "2026-05-22T01:00:00Z",
    selectedRepoFullName: "org/repo",
  });
});

test("listIncidentTitles filters by service and caps to limit", () => {
  const candidates = [
    makeCandidate({ id: "a", service: "api" }),
    makeCandidate({ id: "b", service: "worker" }),
    makeCandidate({ id: "c", service: "api" }),
  ];
  const out = listIncidentTitles(candidates, { service: "api", limit: 1 }) as {
    returned: number;
    totalCandidates: number;
    results: Array<{ id: string }>;
  };
  assert.equal(out.totalCandidates, 3);
  assert.equal(out.returned, 1);
  assert.equal(out.results[0]?.id, "a");
});

test("listIncidentFacets aggregates services, exceptions, environments, endpoint kinds", () => {
  const candidates = [
    makeCandidate({
      id: "a",
      service: "api",
      representative: {
        exceptionType: "ECONNREFUSED",
        message: "GET http://localhost:5173/ failed",
        topFrame: null,
        normalizedFrames: [],
        traceId: null,
        spanId: null,
        resourceAttrs: { "deployment.environment": "production" },
      },
      issues: [
        {
          id: "i1",
          title: "GET http://localhost:5173/ failed",
          service: "api",
          exceptionType: "ECONNREFUSED",
          message: "GET http://localhost:5173/ failed",
          topFrame: null,
          normalizedFrames: [],
          traceId: null,
          spanId: null,
          resourceAttrs: { "deployment.environment": "production" },
          lastSeen: "2026-05-22T00:00:00Z",
        },
      ],
    }),
    makeCandidate({
      id: "b",
      service: "worker",
      representative: {
        exceptionType: "TypeError",
        message: null,
        topFrame: null,
        normalizedFrames: [],
        traceId: null,
        spanId: null,
        resourceAttrs: { "deployment.environment": "staging" },
      },
      issues: [
        {
          id: "i2",
          title: "TypeError near worker.railway.internal",
          service: "worker",
          exceptionType: "TypeError",
          message: "TypeError near worker.railway.internal",
          topFrame: null,
          normalizedFrames: [],
          traceId: null,
          spanId: null,
          resourceAttrs: { "deployment.environment": "staging" },
          lastSeen: "2026-05-22T00:00:00Z",
        },
      ],
    }),
  ];
  const facets = listIncidentFacets(candidates) as {
    services: Array<{ value: string; count: number }>;
    exceptionTypes: Array<{ value: string; count: number }>;
    endpointKinds: Array<{ value: string; count: number }>;
    environments: Array<{ value: string; count: number }>;
  };
  const servicesByName = Object.fromEntries(facets.services.map((r) => [r.value, r.count]));
  assert.equal(servicesByName.api, 2); // candidate + issue
  assert.equal(servicesByName.worker, 2);
  const exceptionsByName = Object.fromEntries(facets.exceptionTypes.map((r) => [r.value, r.count]));
  assert.equal(exceptionsByName.ECONNREFUSED, 1);
  assert.equal(exceptionsByName.TypeError, 1);
  const endpointKindsByName = Object.fromEntries(
    facets.endpointKinds.map((r) => [r.value, r.count]),
  );
  assert.equal(endpointKindsByName.localhost, 1);
  assert.equal(endpointKindsByName.railway_internal, 1);
});

test("searchCandidates ranks by token-match count and tiebreaks by lastSeen DESC", () => {
  const candidates = [
    makeCandidate({
      id: "a",
      title: "ECONNREFUSED to clickhouse",
      lastSeen: "2026-05-22T00:00:00Z",
    }),
    makeCandidate({
      id: "b",
      title: "ECONNREFUSED to clickhouse newer",
      lastSeen: "2026-05-23T00:00:00Z",
    }),
    makeCandidate({
      id: "c",
      title: "Unrelated TypeError",
      representative: {
        exceptionType: "TypeError",
        message: "Cannot read property of undefined",
        topFrame: "render",
        normalizedFrames: ["render"],
        traceId: null,
        spanId: null,
        resourceAttrs: null,
      },
    }),
  ];
  const out = searchCandidates(candidates, { query: "clickhouse ECONNREFUSED" }) as {
    returned: number;
    results: Array<{ id: string; score: number }>;
  };
  // Both "a" and "b" should match, "c" should not.
  assert.equal(out.returned, 2);
  // "b" newer → first.
  assert.equal(out.results[0]?.id, "b");
});

test("searchCandidates with empty query returns all candidates with score 0", () => {
  const candidates = [makeCandidate({ id: "a" }), makeCandidate({ id: "b" })];
  const out = searchCandidates(candidates, { query: "" }) as {
    returned: number;
    results: Array<{ id: string; score: number }>;
  };
  assert.equal(out.returned, 2);
  assert.equal(out.results[0]?.score, 0);
});

test("inspectCandidate returns the candidate when id matches, error otherwise", () => {
  const candidates = [makeCandidate({ id: "a" }), makeCandidate({ id: "b" })];
  assert.equal((inspectCandidate(candidates, { incident_id: "a" }) as { id: string }).id, "a");
  assert.deepEqual(inspectCandidate(candidates, { incident_id: "ghost" }), {
    error: "unknown incident_id: ghost",
  });
});
