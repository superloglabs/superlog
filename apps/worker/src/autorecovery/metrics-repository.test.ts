import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClickHouseClient } from "@clickhouse/client";
import type { CandidateIncident } from "./domain.js";
import { createAutorecoveryMetricsRepository } from "./metrics-repository.js";

type CapturedQuery = { query: string; params: Record<string, unknown> };

function makeFakeCh(
  rows: Array<Record<string, unknown>>,
  opts: { rollupExists?: boolean } = {},
): {
  client: ClickHouseClient;
  captured: CapturedQuery[];
} {
  const captured: CapturedQuery[] = [];
  const client = {
    async query(input: { query: string; query_params: Record<string, unknown> }) {
      captured.push({ query: input.query, params: input.query_params });
      const isProbe = /EXISTS TABLE/i.test(input.query);
      return {
        async json() {
          // The rollup fast path probes `EXISTS TABLE events_per_minute` once;
          // answer it so the data query under test is exercised, defaulting to
          // "rollup present" unless a test opts out.
          if (isProbe) return [{ result: opts.rollupExists === false ? 0 : 1 }];
          return rows;
        },
      };
    },
  } as unknown as ClickHouseClient;
  return { client, captured };
}

// The data query is whatever the repository runs that isn't the availability
// probe.
function dataQuery(captured: CapturedQuery[]): CapturedQuery | undefined {
  return captured.find((q) => !/EXISTS TABLE/i.test(q.query));
}

function makeCandidate(overrides: Partial<CandidateIncident> = {}): CandidateIncident {
  return {
    id: "inc-1",
    projectId: "proj-1",
    title: "API errors",
    codename: "blue-eel",
    service: "@superlog/api",
    firstSeen: new Date("2026-05-22T00:00:00Z"),
    lastSeen: new Date("2026-05-23T02:00:00Z"),
    issueCount: 1,
    issueSignatures: [{ exceptionType: "APIError" }],
    slackChannelId: null,
    slackThreadTs: null,
    slackInstallationId: null,
    ...overrides,
  };
}

test("queryIncidentActivity filters by the candidate's issue exception types", async () => {
  const { client, captured } = makeFakeCh([{ hour: "2026-05-23 00:00:00", count: "2" }]);
  const repo = createAutorecoveryMetricsRepository(async () => client);

  await repo.queryIncidentActivity(makeCandidate(), 24);

  assert.equal(captured.length, 1);
  const q = captured[0];
  assert.ok(q, "expected a CH query to be captured");
  // The query must scope by the actual issue signatures, not just project+service.
  // Without this filter, a project-wide spike in unrelated exceptions (e.g.
  // ECONNREFUSED storm) would be attributed to this incident.
  assert.match(q.query, /\{exception_types:Array\(String\)\}/);
  assert.deepEqual(q.params.exception_types, ["APIError"]);
  // Reads the exception-only projection, not a full ARRAY JOIN Events scan of
  // otel_traces; kind='span' preserves the old otel_traces-only scope.
  assert.match(q.query, /FROM otel_exceptions/);
  assert.match(q.query, /kind = 'span'/);
  assert.doesNotMatch(q.query, /ARRAY JOIN/);
});

test("queryIncidentActivity collapses duplicate exception types and filters by service", async () => {
  const { client, captured } = makeFakeCh([]);
  const repo = createAutorecoveryMetricsRepository(async () => client);

  await repo.queryIncidentActivity(
    makeCandidate({
      issueSignatures: [
        { exceptionType: "APIError" },
        { exceptionType: "APIError" },
        { exceptionType: "TimeoutError" },
      ],
    }),
    12,
  );

  const q = captured[0];
  assert.ok(q);
  assert.deepEqual(
    [...(q.params.exception_types as string[])].sort(),
    ["APIError", "TimeoutError"],
  );
  assert.equal(q.params.service, "@superlog/api");
  assert.equal(q.params.hours, 12);
});

test("queryIncidentActivity short-circuits with zero events when there are no signatures", async () => {
  const { client, captured } = makeFakeCh([{ hour: "x", count: "999" }]);
  const repo = createAutorecoveryMetricsRepository(async () => client);

  const result = await repo.queryIncidentActivity(
    makeCandidate({ issueSignatures: [] }),
    24,
  );

  // No signatures means we can't safely scope the query — fall back to "no
  // signal observed" so the agent stays conservative rather than counting
  // unrelated project-wide errors.
  assert.equal(captured.length, 0);
  assert.deepEqual(result, { totalEvents: 0, perHour: [], lookbackHours: 24 });
});

test("queryServiceTraffic reads the events_per_minute rollup, summing trace counts", async () => {
  const { client, captured } = makeFakeCh([{ hour: "2026-05-23 00:00:00", count: "1500" }]);
  const repo = createAutorecoveryMetricsRepository(async () => client);

  const result = await repo.queryServiceTraffic(makeCandidate(), 6);

  const q = dataQuery(captured);
  assert.ok(q, "expected a data query");
  // The raw otel_traces scan reads every span in the window — 100M+ rows for a
  // high-volume service over a multi-day lookback, which saturated the CH read
  // pool and stalled the rest of the worker tick. The rollup answers the same
  // per-service span count from pre-aggregated minute cells.
  assert.match(q.query, /FROM events_per_minute/);
  assert.doesNotMatch(q.query, /FROM otel_traces/);
  assert.match(q.query, /signal = 'traces'/);
  assert.match(q.query, /sum\(c\)/);
  // Service traffic is the "is the operation still being exercised" signal —
  // it must NOT be narrowed by exception type, otherwise a recovered error
  // path would look like a traffic dropout.
  assert.doesNotMatch(q.query, /exception_types/);
  assert.equal(q.params.service, "@superlog/api");
  assert.equal(q.params.hours, 6);
  assert.equal(result.totalSpans, 1500);
});

test("queryServiceTraffic falls back to the raw otel_traces scan when the rollup is absent", async () => {
  // Self-hosted deployments that never ran the events_per_minute migration
  // (it isn't part of the collector's auto-created schema) must still answer.
  const { client, captured } = makeFakeCh([{ hour: "2026-05-23 00:00:00", count: "1500" }], {
    rollupExists: false,
  });
  const repo = createAutorecoveryMetricsRepository(async () => client);

  const result = await repo.queryServiceTraffic(makeCandidate(), 6);

  const q = dataQuery(captured);
  assert.ok(q, "expected a data query");
  assert.match(q.query, /FROM otel_traces/);
  assert.match(q.query, /ServiceName = \{service:String\}/);
  assert.equal(result.totalSpans, 1500);
});

test("queryServiceTraffic short-circuits without querying when the incident has no service", async () => {
  const { client, captured } = makeFakeCh([{ hour: "x", count: "999" }]);
  const repo = createAutorecoveryMetricsRepository(async () => client);

  const result = await repo.queryServiceTraffic(makeCandidate({ service: null }), 6);

  // No service means no traffic question to ask — don't probe or scan.
  assert.equal(captured.length, 0);
  assert.deepEqual(result, { totalSpans: 0, perHour: [], lookbackHours: 6, service: null });
});
