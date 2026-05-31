import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  buildIncidentStatsFromActivityRows,
  buildIncidentStatsFromIssues,
  buildIncidentStatsPairs,
  buildIncidentStatsWithFallback,
  emptyIncidentStats,
} from "./stats.js";

test("incident stats fallback buckets issue event counts by last seen day", () => {
  const stats = buildIncidentStatsFromIssues(
    [
      { eventCount: 395, lastSeen: new Date("2026-05-25T18:23:04.391Z") },
      { eventCount: 100, lastSeen: new Date("2026-05-27T18:52:35.544Z") },
      { eventCount: 10, lastSeen: new Date("2026-05-01T00:00:00.000Z") },
    ],
    { now: new Date("2026-05-28T19:00:00.000Z"), windowDays: 14 },
  );

  assert.equal(stats.windowDays, 14);
  assert.equal(stats.totalEvents, 495);
  assert.equal(stats.impactedUsers, 0);
  assert.equal(stats.impactedUsersAvailable, false);
  assert.equal(stats.buckets.length, 14);
  assert.equal(stats.buckets.find((b) => b.day === "2026-05-25")?.count, 395);
  assert.equal(stats.buckets.find((b) => b.day === "2026-05-27")?.count, 100);
});

test("incident stats fallback returns empty activity when there are no recent issues", () => {
  const stats = buildIncidentStatsFromIssues(
    [{ eventCount: 10, lastSeen: new Date("2026-05-01T00:00:00.000Z") }],
    { now: new Date("2026-05-28T19:00:00.000Z"), windowDays: 14 },
  );

  assert.deepEqual(stats, emptyIncidentStats(14, new Date("2026-05-28T19:00:00.000Z")));
});

test("incident stats buckets pre-aggregated fingerprint activity rows", () => {
  const stats = buildIncidentStatsFromActivityRows(
    [
      { day: "2026-05-25", count: 395 },
      { day: "2026-05-25", count: "100" },
      { day: "2026-05-27", count: 7 },
    ],
    { now: new Date("2026-05-28T19:00:00.000Z"), windowDays: 14 },
  );

  assert.equal(stats.windowDays, 14);
  assert.equal(stats.totalEvents, 502);
  assert.equal(stats.impactedUsers, 0);
  assert.equal(stats.impactedUsersAvailable, false);
  assert.equal(stats.buckets.find((b) => b.day === "2026-05-25")?.count, 495);
  assert.equal(stats.buckets.find((b) => b.day === "2026-05-27")?.count, 7);
});

test("incident stats returns issue fallback when telemetry load times out", async () => {
  const reasons: string[] = [];
  let aborted = false;

  const stats = await buildIncidentStatsWithFallback({
    fallback: buildIncidentStatsFromIssues(
      [{ eventCount: 7, lastSeen: new Date("2026-05-27T00:00:00.000Z") }],
      { now: new Date("2026-05-28T19:00:00.000Z"), windowDays: 14 },
    ),
    timeoutMs: 5,
    onTelemetryUnavailable: (reason) => reasons.push(reason),
    loadTelemetry: (signal) => {
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      return new Promise(() => undefined);
    },
  });

  assert.equal(aborted, true);
  assert.deepEqual(reasons, ["timeout"]);
  assert.equal(stats.totalEvents, 7);
  assert.equal(stats.buckets.find((b) => b.day === "2026-05-27")?.count, 7);
});

test("incident stats prefers telemetry when it loads before the timeout", async () => {
  const telemetry = {
    windowDays: 14,
    buckets: [{ day: "2026-05-27", count: 42 }],
    totalEvents: 42,
    impactedUsers: 3,
    impactedUsersAvailable: true,
  };

  const stats = await buildIncidentStatsWithFallback({
    fallback: emptyIncidentStats(14, new Date("2026-05-28T19:00:00.000Z")),
    timeoutMs: 50,
    loadTelemetry: async () => telemetry,
  });

  assert.deepEqual(stats, telemetry);
});

test("incident stats span pairs include resolved span names when available", () => {
  const pairs = buildIncidentStatsPairs(
    [
      {
        id: "issue-1",
        kind: "span",
        service: "superlog-api",
        exceptionType: "Error",
        lastSample: { traceId: "trace-1", spanId: "span-1" },
      },
      {
        id: "issue-2",
        kind: "span",
        service: "superlog-api",
        exceptionType: "Error",
        lastSample: { traceId: "trace-2", spanId: "span-2", spanName: "cached.authorize" },
      },
      {
        id: "issue-3",
        kind: "log",
        service: "superlog-api",
        exceptionType: "Error",
        lastSample: null,
      },
    ],
    new Map([["trace-1:span-1", "project.authorize"]]),
  );

  assert.deepEqual(pairs.namedSpanServices, ["superlog-api", "superlog-api"]);
  assert.deepEqual(pairs.namedSpanNames, ["project.authorize", "cached.authorize"]);
  assert.deepEqual(pairs.namedSpanExcTypes, ["Error", "Error"]);
  assert.deepEqual(pairs.unnamedSpanServices, []);
  assert.deepEqual(pairs.unnamedSpanExcTypes, []);
  assert.deepEqual(pairs.logServices, ["superlog-api"]);
  assert.deepEqual(pairs.logExcTypes, ["Error"]);
});

test("incident stats keeps span pairs queryable when span name is unknown", () => {
  const pairs = buildIncidentStatsPairs(
    [
      {
        id: "issue-1",
        kind: "span",
        service: "api",
        exceptionType: "TypeError",
        lastSample: { traceId: "trace-1", spanId: "span-1" },
      },
    ],
    new Map(),
  );

  assert.deepEqual(pairs.namedSpanServices, []);
  assert.deepEqual(pairs.namedSpanNames, []);
  assert.deepEqual(pairs.namedSpanExcTypes, []);
  assert.deepEqual(pairs.unnamedSpanServices, ["api"]);
  assert.deepEqual(pairs.unnamedSpanExcTypes, ["TypeError"]);
});
