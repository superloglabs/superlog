import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { RenderLogCursor } from "@superlog/render";
import {
  type RenderPullerInstallation,
  type RenderPullerStore,
  runRenderPullOnce,
} from "./puller.js";

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const NOW = new Date("2026-07-07T14:20:00Z");

function installation(overrides: Partial<RenderPullerInstallation> = {}): RenderPullerInstallation {
  return {
    id: "inst-1",
    projectId: "proj-1",
    renderApiKey: "rnd_key",
    ownerId: "tea-1",
    ownerName: "Acme",
    ingestKey: "sl_public_abc",
    services: [],
    logCursor: {},
    metricsCursor: {},
    logStreamActive: false,
    metricsStreamActive: false,
    ...overrides,
  };
}

type StoreState = {
  installations: RenderPullerInstallation[];
  savedServices: Array<{ id: string; services: unknown }>;
  savedCursors: Array<{
    id: string;
    logCursor: RenderLogCursor;
    metricsCursor: Record<string, number>;
  }>;
  revoked: string[];
};

function makeStore(installations: RenderPullerInstallation[]): {
  store: RenderPullerStore;
  state: StoreState;
} {
  const state: StoreState = { installations, savedServices: [], savedCursors: [], revoked: [] };
  return {
    store: {
      listActiveInstallations: async () => state.installations,
      saveServices: async (id, services) => {
        state.savedServices.push({ id, services });
      },
      saveCursors: async (id, cursors) => {
        state.savedCursors.push({ id, ...cursors });
      },
      markRevoked: async (id) => {
        state.revoked.push(id);
      },
    },
    state,
  };
}

const SERVICES_PAGE = [
  {
    service: {
      id: "srv-1",
      name: "acme-api",
      type: "web_service",
      suspended: "not_suspended",
      serviceDetails: { region: "oregon" },
    },
    cursor: "c1",
  },
  {
    service: {
      id: "srv-2",
      name: "acme-worker",
      type: "background_worker",
      suspended: "suspended",
      serviceDetails: { region: "oregon" },
    },
    cursor: "c2",
  },
];

const LOG_LINE = {
  id: "log-1",
  timestamp: "2026-07-07T14:19:30Z",
  message: "hello",
  labels: [
    { name: "resource", value: "srv-1" },
    { name: "level", value: "info" },
  ],
};

const CPU_SERIES = {
  labels: [{ field: "resource", value: "srv-1" }],
  unit: "cpu",
  values: [{ timestamp: "2026-07-07T14:19:00Z", value: 0.12 }],
};

// Routing fetch mock: answers Render API + intake calls, records requests.
function makeFetch(
  opts: {
    logsResponses?: Array<Record<string, unknown>>;
    intakeStatus?: number;
  } = {},
) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const logsResponses = [...(opts.logsResponses ?? [])];
  const impl: typeof fetch = async (input, init) => {
    const url = String(input);
    const call = {
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
    };
    calls.push(call);
    const respond = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url.includes("/v1/services")) return respond(SERVICES_PAGE);
    if (url.includes("/v1/logs")) {
      const next = logsResponses.shift() ?? { logs: [], hasMore: false };
      if (typeof next.status === "number") return respond({ message: "rate limited" }, next.status);
      return respond(next);
    }
    if (url.includes("/v1/metrics/cpu")) return respond([CPU_SERIES]);
    if (url.includes("/v1/metrics/")) return respond([]);
    if (url.includes("/render/pull/")) return respond({}, opts.intakeStatus ?? 200);
    throw new Error(`unexpected fetch: ${url}`);
  };
  return { impl, calls };
}

test("first pass seeds logs backward, forwards fresh telemetry, persists cursors", async () => {
  const { store, state } = makeStore([installation()]);
  const { impl, calls } = makeFetch({ logsResponses: [{ logs: [LOG_LINE], hasMore: false }] });

  const stats = await runRenderPullOnce({
    store,
    intakeBaseUrl: "http://intake.test",
    log: silentLog,
    fetchImpl: impl,
    now: () => NOW,
    metricsPollState: new Map(),
  });

  assert.equal(stats.installations, 1);
  assert.equal(stats.logsForwarded, 1);
  assert.equal(stats.metricPointsForwarded, 1);
  assert.equal(stats.errors, 0);

  // Inventory snapshot refreshed (both services, incl. the suspended one).
  assert.equal(state.savedServices.length, 1);

  // The backward seed read has no `direction=forward` and no startTime.
  const logCall = calls.find((c) => c.url.includes("/v1/logs"));
  assert.ok(logCall && !logCall.url.includes("direction=forward"));
  // Suspended services are excluded from the pull.
  assert.ok(logCall?.url.includes("resource=srv-1"));
  assert.ok(!logCall?.url.includes("resource=srv-2"));

  // Log + metric exports hit the intake with the ingest key.
  const intakeCalls = calls.filter((c) => new URL(c.url).origin === "http://intake.test");
  assert.deepEqual(
    intakeCalls.map((c) => c.url),
    ["http://intake.test/render/pull/logs", "http://intake.test/render/pull/metrics"],
  );

  // Cursors persisted: log cursor at the seed line, metrics cursor per key.
  assert.equal(state.savedCursors.length, 1);
  const cursors = state.savedCursors[0];
  assert.deepEqual(cursors?.logCursor.oregon, { ts: "2026-07-07T14:19:30Z", ids: ["log-1"] });
  assert.equal(cursors?.metricsCursor["srv-1:cpu"], Date.parse("2026-07-07T14:19:00Z") / 1000);
});

test("cursor pass reads forward with pagination and dedupes already-seen lines", async () => {
  const older = { ...LOG_LINE, timestamp: "2026-07-07T14:18:00Z" };
  const fresh = { ...LOG_LINE, id: "log-2", timestamp: "2026-07-07T14:19:45Z" };
  const { store, state } = makeStore([
    installation({
      logCursor: { oregon: "2026-07-07T14:19:00Z" },
      metricsCursor: { "srv-1:cpu": Date.parse("2026-07-07T14:19:00Z") / 1000 },
    }),
  ]);
  const { impl, calls } = makeFetch({
    logsResponses: [
      { logs: [older], hasMore: true, nextStartTime: "2026-07-07T14:19:10Z" },
      { logs: [fresh], hasMore: false },
    ],
  });

  const stats = await runRenderPullOnce({
    store,
    intakeBaseUrl: "http://intake.test",
    log: silentLog,
    fetchImpl: impl,
    now: () => NOW,
    metricsPollState: new Map(),
  });

  // Two log pages were read forward from the cursor.
  const logCalls = calls.filter((c) => c.url.includes("/v1/logs"));
  assert.equal(logCalls.length, 2);
  assert.ok(logCalls[0]?.url.includes("direction=forward"));
  assert.ok(logCalls[0]?.url.includes(encodeURIComponent("2026-07-07T14:19:00Z")));
  assert.ok(logCalls[1]?.url.includes(encodeURIComponent("2026-07-07T14:19:10Z")));

  // Only the line newer than the cursor was forwarded; the metric sample at
  // the cursor was fully deduped so no metrics export happened.
  assert.equal(stats.logsForwarded, 1);
  assert.equal(stats.metricPointsForwarded, 0);
  const intakeCalls = calls.filter((c) => new URL(c.url).origin === "http://intake.test");
  assert.equal(intakeCalls.length, 1);

  const cursors = state.savedCursors[0];
  assert.deepEqual(cursors?.logCursor.oregon, { ts: "2026-07-07T14:19:45Z", ids: ["log-2"] });
});

test("metrics polls are gated by the interval clock", async () => {
  const pollState = new Map<string, number>();
  const { store } = makeStore([installation({ logCursor: { oregon: "2026-07-07T14:19:50Z" } })]);
  const first = makeFetch();
  await runRenderPullOnce({
    store,
    intakeBaseUrl: "http://intake.test",
    log: silentLog,
    fetchImpl: first.impl,
    now: () => NOW,
    metricsPollState: pollState,
  });
  assert.ok(first.calls.some((c) => c.url.includes("/v1/metrics/cpu")));

  // A pass one minute later skips metrics entirely (interval is 5 min).
  const second = makeFetch();
  await runRenderPullOnce({
    store,
    intakeBaseUrl: "http://intake.test",
    log: silentLog,
    fetchImpl: second.impl,
    now: () => new Date(NOW.getTime() + 60_000),
    metricsPollState: pollState,
  });
  assert.ok(!second.calls.some((c) => c.url.includes("/v1/metrics/")));
});

test("provisioned streams suppress polling for their signal", async () => {
  const { store, state } = makeStore([
    installation({ logStreamActive: true, metricsStreamActive: true }),
  ]);
  const { impl, calls } = makeFetch();

  const stats = await runRenderPullOnce({
    store,
    intakeBaseUrl: "http://intake.test",
    log: silentLog,
    fetchImpl: impl,
    now: () => NOW,
    metricsPollState: new Map(),
  });

  // Inventory still refreshes (cheap, keeps the snapshot + revocation checks
  // alive), but no log or metric reads and nothing forwarded.
  assert.ok(calls.some((c) => c.url.includes("/v1/services")));
  assert.ok(!calls.some((c) => c.url.includes("/v1/logs")));
  assert.ok(!calls.some((c) => c.url.includes("/v1/metrics/")));
  assert.equal(stats.logsForwarded, 0);
  assert.equal(stats.metricPointsForwarded, 0);
  assert.equal(state.savedCursors.length, 0);
});

test("a persistently rejected key is soft-revoked after three passes", async () => {
  const { store, state } = makeStore([installation()]);
  const impl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/v1/services")) {
      return new Response(JSON.stringify({ message: "unauthorized" }), { status: 401 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const unauthorizedState = new Map<string, number>();
  const run = () =>
    runRenderPullOnce({
      store,
      intakeBaseUrl: "http://intake.test",
      log: silentLog,
      fetchImpl: impl,
      now: () => NOW,
      metricsPollState: new Map(),
      unauthorizedState,
    });

  const stats = await run();
  assert.equal(stats.installations, 1);
  assert.equal(stats.logsForwarded, 0);
  assert.equal(state.savedCursors.length, 0);
  // Two rejected passes: still just skipping.
  assert.deepEqual(state.revoked, []);
  await run();
  assert.deepEqual(state.revoked, []);
  // Third consecutive rejection revokes the install.
  await run();
  assert.deepEqual(state.revoked, ["inst-1"]);
});

test("an intake rejection keeps the cursor so nothing is lost", async () => {
  const { store, state } = makeStore([
    installation({ logCursor: { oregon: "2026-07-07T14:19:00Z" } }),
  ]);
  const { impl } = makeFetch({
    logsResponses: [{ logs: [{ ...LOG_LINE, timestamp: "2026-07-07T14:19:45Z" }], hasMore: false }],
    intakeStatus: 503,
  });

  const stats = await runRenderPullOnce({
    store,
    intakeBaseUrl: "http://intake.test",
    log: silentLog,
    fetchImpl: impl,
    now: () => NOW,
    metricsPollState: new Map(),
  });
  assert.ok(stats.errors >= 1);
  assert.equal(stats.logsForwarded, 0);
  // The log cursor must not advance past unforwarded lines. (Metrics may have
  // failed too; either way nothing recorded a log-cursor move.)
  const moved = state.savedCursors.some((c) => c.logCursor.oregon !== "2026-07-07T14:19:00Z");
  assert.equal(moved, false);
});

// One forward page per call, each pointing at the next, until the test's
// clock: a backlog longer than any budget.
function endlessLogPages(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({
    logs: [
      {
        ...LOG_LINE,
        id: `log-${i}`,
        timestamp: new Date(Date.parse("2026-07-07T13:00:00Z") + i * 1000).toISOString(),
      },
    ],
    hasMore: true,
    nextStartTime: new Date(Date.parse("2026-07-07T13:00:00Z") + (i + 1) * 1000).toISOString(),
  }));
}

test("a backlog is read up to the installation's page budget, split across regions", async () => {
  const oneRegion = makeStore([installation({ logCursor: { oregon: "2026-07-07T12:59:59Z" } })]);
  const single = makeFetch({ logsResponses: endlessLogPages(40) });
  await runRenderPullOnce({
    store: oneRegion.store,
    intakeBaseUrl: "http://intake.test",
    log: silentLog,
    fetchImpl: single.impl,
    now: () => NOW,
    metricsPollState: new Map(),
  });
  assert.equal(single.calls.filter((c) => c.url.includes("/v1/logs")).length, 24);

  const twoRegions = makeStore([
    installation({
      services: [
        { id: "srv-1", name: "acme-api", type: "web_service", region: "oregon", suspended: false },
        {
          id: "srv-3",
          name: "acme-eu",
          type: "web_service",
          region: "frankfurt",
          suspended: false,
        },
      ],
      logCursor: { oregon: "2026-07-07T12:59:59Z", frankfurt: "2026-07-07T12:59:59Z" },
    }),
  ]);
  const split = makeFetch({ logsResponses: endlessLogPages(40) });
  // The inventory read answers with the one-region fixture, so keep the
  // stored two-region snapshot by failing that read.
  const impl: typeof fetch = async (input, init) =>
    String(input).includes("/v1/services")
      ? new Response("{}", { status: 500 })
      : split.impl(input, init);
  await runRenderPullOnce({
    store: twoRegions.store,
    intakeBaseUrl: "http://intake.test",
    log: silentLog,
    fetchImpl: impl,
    now: () => NOW,
    metricsPollState: new Map(),
  });
  assert.equal(split.calls.filter((c) => c.url.includes("/v1/logs")).length, 24);
});

test("a failed later page keeps the pages already read", async () => {
  const { store, state } = makeStore([
    installation({ logCursor: { oregon: "2026-07-07T12:59:59Z" } }),
  ]);
  const { impl } = makeFetch({ logsResponses: [...endlessLogPages(2), { status: 429 }] });

  const stats = await runRenderPullOnce({
    store,
    intakeBaseUrl: "http://intake.test",
    log: silentLog,
    fetchImpl: impl,
    now: () => NOW,
    metricsPollState: new Map(),
  });

  assert.equal(stats.logsForwarded, 2);
  assert.ok(stats.errors >= 1);
  const saved = state.savedCursors.at(-1);
  assert.deepEqual(saved?.logCursor.oregon, { ts: "2026-07-07T13:00:01.000Z", ids: ["log-1"] });
});
