import { strict as assert } from "node:assert";
import { test } from "node:test";
import { RAILWAY_GRAPHQL_URL, RAILWAY_OAUTH_TOKEN_URL } from "@superlog/railway";
import {
  type RailwayPullerInstallation,
  type RailwayPullerStore,
  runRailwayPullOnce,
} from "./puller.js";

const NOW = new Date("2026-07-07T15:00:00.000Z");
const CONFIG = { clientId: "cid", clientSecret: "cs", redirectUri: "https://r" };
const LOGGER = { info() {}, warn() {}, error() {} };

function installation(
  overrides: Partial<RailwayPullerInstallation> = {},
): RailwayPullerInstallation {
  return {
    id: "inst-1",
    projectId: "superlog-project",
    accessToken: "at",
    refreshToken: "rt",
    tokenExpiresAt: new Date(NOW.getTime() + 60 * 60 * 1000),
    ingestKey: "sl_public_test",
    grantedProjects: [
      { id: "rp-1", name: "blackbird", workspaceId: "ws", workspaceName: "Superlog" },
    ],
    logCursor: {},
    metricsCursor: {},
    ...overrides,
  };
}

type StoreCalls = {
  tokens: Array<{ id: string; accessToken: string; refreshToken: string | null }>;
  cursors: Array<{
    id: string;
    logCursor: Record<string, string>;
    metricsCursor: Record<string, number>;
  }>;
  granted: number;
};

function fakeStore(rows: RailwayPullerInstallation[]): {
  store: RailwayPullerStore;
  calls: StoreCalls;
} {
  const calls: StoreCalls = { tokens: [], cursors: [], granted: 0 };
  return {
    calls,
    store: {
      async listActiveInstallations() {
        return rows;
      },
      async saveTokens(id, tokens) {
        calls.tokens.push({
          id,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
        });
      },
      async saveGrantedProjects() {
        calls.granted += 1;
      },
      async saveCursors(id, cursors) {
        calls.cursors.push({ id, ...cursors });
      },
    },
  };
}

type ForwardedPayload = {
  resourceLogs?: Array<{
    scopeLogs: Array<{ logRecords: Array<{ body: { stringValue?: string } }> }>;
  }>;
  resourceMetrics?: Array<{
    scopeMetrics: Array<{
      metrics: Array<{
        name: string;
        unit: string;
        gauge: { dataPoints: Array<{ timeUnixNano: string; asDouble: number }> };
      }>;
    }>;
  }>;
};

type Forwarded = Array<{ url: string; apiKey: string | null; payload: ForwardedPayload }>;

// Index into an array with narrowing (strict indexing forbids bare [0]).
function at<T>(items: readonly T[] | undefined, index: number): T {
  const item = items?.[index];
  assert.ok(item !== undefined, `expected item at index ${index}`);
  return item;
}

/**
 * Fake fetch that routes token / GraphQL / intake requests. GraphQL responses
 * are dispatched on query content.
 */
function fakeFetch(opts: {
  logs?: unknown[];
  metrics?: unknown[];
  forwarded: Forwarded;
  intakeStatus?: number;
  refreshResponse?: Record<string, unknown>;
}): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u === RAILWAY_OAUTH_TOKEN_URL) {
      return new Response(
        JSON.stringify(
          opts.refreshResponse ?? {
            access_token: "at-new",
            refresh_token: "rt-new",
            expires_in: 3600,
          },
        ),
        { status: 200 },
      );
    }
    if (u === RAILWAY_GRAPHQL_URL) {
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes("externalWorkspaces")) {
        return gql({
          externalWorkspaces: [
            { id: "ws", name: "Superlog", projects: [{ id: "rp-1", name: "blackbird" }] },
          ],
        });
      }
      if (body.query.includes("environments { edges")) {
        return gql({
          project: {
            environments: { edges: [{ node: { id: "env-1", name: "production" } }] },
            services: { edges: [{ node: { id: "svc-1", name: "blackbird-app" } }] },
          },
        });
      }
      if (body.query.includes("environmentLogs")) {
        return gql({ environmentLogs: opts.logs ?? [] });
      }
      if (body.query.includes("metrics(")) {
        return gql({ metrics: opts.metrics ?? [] });
      }
      throw new Error(`unrouted GraphQL query: ${body.query.slice(0, 60)}`);
    }
    // Intake forward.
    opts.forwarded.push({
      url: u,
      apiKey: new Headers(init?.headers).get("x-api-key"),
      payload: JSON.parse(String(init?.body)),
    });
    return new Response("{}", { status: opts.intakeStatus ?? 200 });
  }) as typeof fetch;

  function gql(data: unknown): Response {
    return new Response(JSON.stringify({ data }), { status: 200 });
  }
}

const LOG_LINE = {
  timestamp: "2026-07-07T14:59:59.5Z",
  severity: "info",
  message: "hello",
  tags: { serviceId: "svc-1", environmentId: "env-1", deploymentId: "dep-1" },
  attributes: [],
};

test("forwards fresh logs to the intake with the ingest key and advances the cursor", async () => {
  const { store, calls } = fakeStore([
    installation({ logCursor: { "env-1": "2026-07-07T14:59:00Z" } }),
  ]);
  const forwarded: Forwarded = [];
  const stats = await runRailwayPullOnce({
    store,
    config: CONFIG,
    intakeBaseUrl: "https://intake.test/",
    log: LOGGER,
    now: () => NOW,
    fetchImpl: fakeFetch({ logs: [LOG_LINE], forwarded }),
    metricsIntervalSeconds: 999999,
    metricsPollState: new Map([["inst-1:env-1:svc-1", Math.floor(NOW.getTime() / 1000)]]),
  });

  assert.equal(stats.logsForwarded, 1);
  assert.equal(stats.errors, 0);
  assert.equal(forwarded.length, 1);
  assert.equal(at(forwarded, 0).url, "https://intake.test/railway/pull/logs");
  assert.equal(at(forwarded, 0).apiKey, "sl_public_test");
  const record = at(at(at(at(forwarded, 0).payload.resourceLogs, 0).scopeLogs, 0).logRecords, 0);
  assert.equal(record.body.stringValue, "hello");
  assert.equal(calls.cursors.length, 1);
  assert.equal(at(calls.cursors, 0).logCursor["env-1"], "2026-07-07T14:59:59.5Z");
});

test("seeds the log cursor on first pull so history isn't re-read", async () => {
  const { store, calls } = fakeStore([installation()]);
  const forwarded: Forwarded = [];
  await runRailwayPullOnce({
    store,
    config: CONFIG,
    intakeBaseUrl: "https://intake.test",
    log: LOGGER,
    now: () => NOW,
    fetchImpl: fakeFetch({ logs: [LOG_LINE], forwarded }),
    metricsIntervalSeconds: 999999,
    metricsPollState: new Map([["inst-1:env-1:svc-1", Math.floor(NOW.getTime() / 1000)]]),
  });
  // Seed batch is forwarded once, and the cursor lands on its max timestamp.
  assert.equal(forwarded.length, 1);
  assert.equal(at(calls.cursors, 0).logCursor["env-1"], "2026-07-07T14:59:59.5Z");
});

test("does not advance the cursor when the intake rejects the batch", async () => {
  const { store, calls } = fakeStore([
    installation({ logCursor: { "env-1": "2026-07-07T14:59:00Z" } }),
  ]);
  const forwarded: Forwarded = [];
  const stats = await runRailwayPullOnce({
    store,
    config: CONFIG,
    intakeBaseUrl: "https://intake.test",
    log: LOGGER,
    now: () => NOW,
    fetchImpl: fakeFetch({ logs: [LOG_LINE], forwarded, intakeStatus: 503 }),
    metricsIntervalSeconds: 999999,
    metricsPollState: new Map([["inst-1:env-1:svc-1", Math.floor(NOW.getTime() / 1000)]]),
  });
  assert.ok(stats.errors >= 1);
  assert.equal(calls.cursors.length, 0, "cursor must not advance past unforwarded logs");
});

test("refreshes an expiring token and persists the rotated refresh token first", async () => {
  const { store, calls } = fakeStore([
    installation({ tokenExpiresAt: new Date(NOW.getTime() + 30 * 1000) }),
  ]);
  const forwarded: Forwarded = [];
  await runRailwayPullOnce({
    store,
    config: CONFIG,
    intakeBaseUrl: "https://intake.test",
    log: LOGGER,
    now: () => NOW,
    fetchImpl: fakeFetch({ logs: [], forwarded }),
    metricsIntervalSeconds: 999999,
    metricsPollState: new Map([["inst-1:env-1:svc-1", Math.floor(NOW.getTime() / 1000)]]),
  });
  assert.equal(calls.tokens.length, 1);
  assert.equal(at(calls.tokens, 0).accessToken, "at-new");
  assert.equal(at(calls.tokens, 0).refreshToken, "rt-new");
});

test("skips an installation whose token expired with no refresh token", async () => {
  const { store, calls } = fakeStore([
    installation({ refreshToken: null, tokenExpiresAt: new Date(NOW.getTime() - 1000) }),
  ]);
  const forwarded: Forwarded = [];
  const stats = await runRailwayPullOnce({
    store,
    config: CONFIG,
    intakeBaseUrl: "https://intake.test",
    log: LOGGER,
    now: () => NOW,
    fetchImpl: fakeFetch({ logs: [LOG_LINE], forwarded }),
  });
  assert.equal(stats.logsForwarded, 0);
  assert.equal(forwarded.length, 0);
  assert.equal(calls.cursors.length, 0);
});

test("uses firstPullLogBatchLimit instead of logBatchLimit when no cursor exists for the environment", async () => {
  const { store } = fakeStore([installation()]);
  const capturedLimits: number[] = [];
  const fetchImpl: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u === RAILWAY_GRAPHQL_URL) {
      const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
      if (body.query.includes("externalWorkspaces")) {
        return new Response(
          JSON.stringify({
            data: {
              externalWorkspaces: [
                { id: "ws", name: "Superlog", projects: [{ id: "rp-1", name: "blackbird" }] },
              ],
            },
          }),
          { status: 200 },
        );
      }
      if (body.query.includes("environments { edges")) {
        return new Response(
          JSON.stringify({
            data: {
              project: {
                environments: { edges: [{ node: { id: "env-1", name: "production" } }] },
                services: { edges: [{ node: { id: "svc-1", name: "blackbird-app" } }] },
              },
            },
          }),
          { status: 200 },
        );
      }
      if (body.query.includes("environmentLogs")) {
        const limit =
          (body.variables["beforeLimit"] as number | undefined) ??
          (body.variables["afterLimit"] as number | undefined);
        if (limit !== undefined) capturedLimits.push(limit);
        return new Response(JSON.stringify({ data: { environmentLogs: [] } }), { status: 200 });
      }
      if (body.query.includes("metrics(")) {
        return new Response(JSON.stringify({ data: { metrics: [] } }), { status: 200 });
      }
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  await runRailwayPullOnce({
    store,
    config: CONFIG,
    intakeBaseUrl: "https://intake.test",
    log: LOGGER,
    now: () => NOW,
    fetchImpl,
    logBatchLimit: 1000,
    firstPullLogBatchLimit: 50,
    metricsIntervalSeconds: 999999,
    metricsPollState: new Map([["inst-1:env-1:svc-1", Math.floor(NOW.getTime() / 1000)]]),
  });

  assert.ok(capturedLimits.length > 0, "expected at least one environmentLogs request");
  for (const limit of capturedLimits) {
    assert.equal(limit, 50, "first-pull should use firstPullLogBatchLimit, not logBatchLimit");
  }
});

test("polls metrics on the interval, forwards gauges, and advances the sample cursor", async () => {
  const { store, calls } = fakeStore([
    installation({ logCursor: { "env-1": "2026-07-07T15:00:00Z" } }),
  ]);
  const forwarded: Forwarded = [];
  const nowSec = Math.floor(NOW.getTime() / 1000);
  const stats = await runRailwayPullOnce({
    store,
    config: CONFIG,
    intakeBaseUrl: "https://intake.test",
    log: LOGGER,
    now: () => NOW,
    fetchImpl: fakeFetch({
      logs: [],
      metrics: [
        {
          measurement: "CPU_USAGE",
          values: [{ ts: nowSec - 60, value: 0.5 }],
          tags: { serviceId: "svc-1" },
        },
      ],
      forwarded,
    }),
    metricsPollState: new Map(),
  });
  assert.equal(stats.metricPointsForwarded, 1);
  const metricsPost = forwarded.find((f) => f.url.endsWith("/railway/pull/metrics"));
  assert.ok(metricsPost);
  const metric = at(at(at(metricsPost.payload.resourceMetrics, 0).scopeMetrics, 0).metrics, 0);
  assert.equal(metric.name, "railway.cpu.usage");
  assert.equal(at(metric.gauge.dataPoints, 0).asDouble, 0.5);
  assert.equal(at(calls.cursors, calls.cursors.length - 1).metricsCursor["env-1:svc-1"], nowSec - 60);

  // A second pass inside the interval must not poll metrics again.
  const forwardedBefore = forwarded.length;
  await runRailwayPullOnce({
    store,
    config: CONFIG,
    intakeBaseUrl: "https://intake.test",
    log: LOGGER,
    now: () => new Date(NOW.getTime() + 60 * 1000),
    fetchImpl: fakeFetch({ logs: [], metrics: [], forwarded }),
    metricsPollState: new Map([["inst-1:env-1:svc-1", nowSec]]),
  });
  assert.equal(
    forwarded.filter((f) => f.url.endsWith("/railway/pull/metrics")).length,
    forwarded.slice(0, forwardedBefore).filter((f) => f.url.endsWith("/railway/pull/metrics"))
      .length,
  );
});
