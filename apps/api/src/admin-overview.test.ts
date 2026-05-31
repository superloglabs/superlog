import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  adminTraceIngestBucketsQuery,
  buildAdminOrgOverview,
  type AdminOverviewSources,
} from "./admin-overview.js";

test("admin overview returns org rows when trace telemetry times out", async () => {
  const timedOut: string[] = [];
  let traceWasAborted = false;
  const sources: AdminOverviewSources = {
    loadOrgs: async () => [
      {
        id: "org-1",
        name: "Acme",
        slug: "acme",
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
        signupSource: "web",
      },
    ],
    loadGithubConnections: async () => [],
    loadSlackConnections: async () => [],
    loadMcpConnections: async () => [],
    loadIncidentBuckets: async () => [{ orgId: "org-1", thisWeek: 2, prevWeek: 1 }],
    loadPrOpenedBuckets: async () => [],
    loadPrMergedBuckets: async () => [],
    loadMembers: async () => [
      {
        orgId: "org-1",
        userId: "user-1",
        email: "admin@example.com",
        name: "Admin",
        joinedAt: new Date("2026-05-02T00:00:00.000Z"),
      },
    ],
    loadTraceBuckets: (signal) => {
      signal.addEventListener("abort", () => {
        traceWasAborted = true;
      });
      return new Promise(() => undefined);
    },
  };

  const started = Date.now();
  const rows = await buildAdminOrgOverview(sources, {
    traceTimeoutMs: 5,
    onTraceTelemetryUnavailable: (reason) => timedOut.push(reason),
  });

  assert.ok(Date.now() - started < 200);
  assert.equal(traceWasAborted, true);
  assert.deepEqual(timedOut, ["timeout"]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.org.slug, "acme");
  assert.equal(rows[0]?.thisWeek.traces, 0);
  assert.equal(rows[0]?.prevWeek.traces, 0);
  assert.equal(rows[0]?.thisWeek.incidents, 2);
});

test("admin overview aggregates trace buckets by org", async () => {
  const rows = await buildAdminOrgOverview(baseSources(), { traceTimeoutMs: 50 });

  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => ({
      slug: r.org.slug,
      traces: r.thisWeek.traces,
      prevTraces: r.prevWeek.traces,
      incidents: r.thisWeek.incidents,
      prsOpened: r.thisWeek.prsOpened,
      prsMerged: r.thisWeek.prsMerged,
    })),
    [
      {
        slug: "active",
        traces: 13,
        prevTraces: 7,
        incidents: 1,
        prsOpened: 2,
        prsMerged: 1,
      },
      {
        slug: "quiet",
        traces: 0,
        prevTraces: 0,
        incidents: 0,
        prsOpened: 0,
        prsMerged: 0,
      },
    ],
  );
});

test("admin trace ingest query buckets per-sample deltas into each week", () => {
  const query = adminTraceIngestBucketsQuery();

  assert.match(query, /lagInFrame\(value, 1, NULL\)/);
  assert.match(query, /greatest\(value - prev_value, 0\) AS delta/);
  assert.match(
    query,
    /coalesce\(sumIf\(delta, sample_time >= now\(\) - INTERVAL 7 DAY\), 0\) AS this_week/,
  );
  assert.match(
    query,
    /coalesce\(sumIf\(delta, sample_time >= now\(\) - INTERVAL 14 DAY AND sample_time < now\(\) - INTERVAL 7 DAY\), 0\) AS prev_week/,
  );
  assert.doesNotMatch(query, /last_value - first_value/);
});

function baseSources(): AdminOverviewSources {
  return {
    loadOrgs: async () => [
      {
        id: "org-active",
        name: "Active",
        slug: "active",
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
        signupSource: null,
      },
      {
        id: "org-quiet",
        name: "Quiet",
        slug: "quiet",
        createdAt: new Date("2026-05-03T00:00:00.000Z"),
        signupSource: null,
      },
    ],
    loadGithubConnections: async () => [
      { orgId: "org-active", connectedAt: new Date("2026-05-04T00:00:00.000Z") },
    ],
    loadSlackConnections: async () => [],
    loadMcpConnections: async () => [],
    loadIncidentBuckets: async () => [{ orgId: "org-active", thisWeek: 1, prevWeek: 3 }],
    loadPrOpenedBuckets: async () => [{ orgId: "org-active", thisWeek: 2, prevWeek: 1 }],
    loadPrMergedBuckets: async () => [{ orgId: "org-active", thisWeek: 1, prevWeek: 0 }],
    loadMembers: async () => [],
    loadTraceBuckets: async () => [
      { orgId: "org-active", thisWeek: 10, prevWeek: 5 },
      { orgId: "org-active", thisWeek: 3, prevWeek: 2 },
      { orgId: "deleted-org", thisWeek: 100, prevWeek: 100 },
    ],
  };
}
