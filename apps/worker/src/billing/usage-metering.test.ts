import assert from "node:assert/strict";
import { test } from "node:test";
import { type UsageMeterDeps, aggregateByOrg, meterTelemetryUsageTick } from "./usage-metering.js";

test("aggregateByOrg sums projects into their org and drops unknown projects", () => {
  const perProject = new Map([
    ["p1", 100],
    ["p2", 50],
    ["p3", 7], // no org mapping → dropped
  ]);
  const projectToOrg = new Map([
    ["p1", "orgA"],
    ["p2", "orgA"],
  ]);
  assert.deepEqual([...aggregateByOrg(perProject, projectToOrg)], [["orgA", 150]]);
});

function deps(overrides: Partial<UsageMeterDeps> = {}): {
  deps: UsageMeterDeps;
  tracks: Array<{ orgId: string; featureId: string; value: number }>;
  cursors: Map<string, Date>;
} {
  const tracks: Array<{ orgId: string; featureId: string; value: number }> = [];
  const cursors = new Map<string, Date>();
  const base: UsageMeterDeps = {
    countByProject: async () => new Map([["p1", 10]]),
    resolveOrgIds: async () => new Map([["p1", "orgA"]]),
    track: async (orgId, featureId, value) => {
      tracks.push({ orgId, featureId, value });
    },
    getCursor: async (name) => cursors.get(name) ?? new Date("2026-05-01T00:00:00Z"),
    setCursor: async (name, at) => {
      cursors.set(name, at);
    },
    now: () => new Date("2026-05-01T00:10:00Z"),
    windowMs: 5 * 60 * 1000,
    ...overrides,
  };
  return { deps: base, tracks, cursors };
}

test("reports per-org deltas for each signal and advances the cursor by one window", async () => {
  const { deps: d, tracks, cursors } = deps();
  const reported = await meterTelemetryUsageTick(d);
  // 3 signals × 1 org each
  assert.equal(reported, 3);
  assert.deepEqual(tracks.map((t) => t.featureId).sort(), ["logs", "metric_points", "spans"]);
  assert.ok(tracks.every((t) => t.orgId === "orgA" && t.value === 10));
  // cursor advanced to start + windowMs (capped below now)
  assert.equal(cursors.get("usage-meter-spans")?.toISOString(), "2026-05-01T00:05:00.000Z");
});

test("empty windows still advance the cursor and report nothing", async () => {
  const { deps: d, tracks, cursors } = deps({ countByProject: async () => new Map() });
  const reported = await meterTelemetryUsageTick(d);
  assert.equal(reported, 0);
  assert.equal(tracks.length, 0);
  assert.ok(cursors.get("usage-meter-logs") instanceof Date);
});

test("a track failure is swallowed and the cursor still advances (at-most-once)", async () => {
  const { deps: d, cursors } = deps({
    track: async () => {
      throw new Error("autumn down");
    },
  });
  const reported = await meterTelemetryUsageTick(d); // must not throw
  assert.equal(reported, 0);
  assert.ok(cursors.get("usage-meter-spans") instanceof Date);
});

test("a signal count failure preserves its cursor and does not block later signals", async () => {
  const counted: string[] = [];
  const {
    deps: d,
    tracks,
    cursors,
  } = deps({
    countByProject: async (signal) => {
      counted.push(signal);
      if (signal === "logs") throw new Error("clickhouse timeout");
      return new Map([["p1", 10]]);
    },
  });

  const reported = await meterTelemetryUsageTick(d);

  assert.equal(reported, 2);
  assert.deepEqual(counted, ["spans", "logs", "metric_points"]);
  assert.deepEqual(
    tracks.map((track) => track.featureId),
    ["spans", "metric_points"],
  );
  assert.ok(cursors.get("usage-meter-spans") instanceof Date);
  assert.equal(cursors.has("usage-meter-logs"), false);
  assert.ok(cursors.get("usage-meter-metric_points") instanceof Date);
});

test("cancellation after counting preserves the cursor and skips delivery", async () => {
  let cancelled = false;
  let countCalls = 0;
  const {
    deps: d,
    tracks,
    cursors,
  } = deps({
    countByProject: async () => {
      countCalls += 1;
      cancelled = true;
      return new Map([["p1", 10]]);
    },
    isCancelled: () => cancelled,
  });

  const reported = await meterTelemetryUsageTick(d);

  assert.equal(reported, 0);
  assert.equal(countCalls, 1);
  assert.equal(tracks.length, 0);
  assert.equal(cursors.size, 0);
});

test("an org lookup failure preserves its cursor and does not block later signals", async () => {
  const {
    deps: d,
    tracks,
    cursors,
  } = deps({
    countByProject: async (signal) => new Map([[`project-${signal}`, 10]]),
    resolveOrgIds: async (projectIds) => {
      if (projectIds.includes("project-logs")) throw new Error("postgres timeout");
      return new Map(projectIds.map((projectId) => [projectId, "orgA"]));
    },
  });

  const reported = await meterTelemetryUsageTick(d);

  assert.equal(reported, 2);
  assert.deepEqual(
    tracks.map((track) => track.featureId),
    ["spans", "metric_points"],
  );
  assert.ok(cursors.get("usage-meter-spans") instanceof Date);
  assert.equal(cursors.has("usage-meter-logs"), false);
  assert.ok(cursors.get("usage-meter-metric_points") instanceof Date);
});

test("does not scan past now (window capped at current time)", async () => {
  const counted: Array<{ after: string; until: string }> = [];
  const { deps: d } = deps({
    getCursor: async () => new Date("2026-05-01T00:09:30Z"),
    now: () => new Date("2026-05-01T00:10:00Z"),
    countByProject: async (_s, after, until) => {
      counted.push({ after, until });
      return new Map();
    },
  });
  await meterTelemetryUsageTick(d);
  // 30s remaining < 5min window → until clamps to now, not cursor+window
  assert.equal(counted[0]?.until, "2026-05-01T00:10:00.000Z");
});
