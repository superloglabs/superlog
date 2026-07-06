import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Issue, IssueSample } from "@superlog/db";

// detail.ts transitively imports the db client, which throws at import time
// without a connection string. Set a dummy URL before the dynamic import (the
// porsager client connects lazily, so these pure-function tests never open a
// socket). Same dynamic-import pattern as linear.test.ts / loops.test.ts.
process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";
const { toIssueContext } = await import("./detail.js");

test("issue context carries the stored telemetry sample as-is", () => {
  const sample: IssueSample = {
    kind: "span",
    service: "api",
    severity: "ERROR",
    message: "boom",
    body: null,
    exceptionType: "TypeError",
    topFrame: "checkout.ts:42",
    normalizedFrames: ["checkout.ts:42", "handler.ts:10"],
    stacktrace: "TypeError: boom\n  at checkout.ts:42",
    seenAt: "2026-05-24T01:00:00.000Z",
    traceId: "abc123",
    spanId: "def456",
    spanName: "POST /checkout",
    spanAttrs: { "http.route": "/checkout" },
  };
  const ctx = toIssueContext({ ...baseIssue(), lastSample: sample });

  assert.equal(ctx.id, "issue-1");
  assert.equal(ctx.kind, "span");
  assert.equal(ctx.exceptionType, "TypeError");
  assert.equal(ctx.eventCount, 12);
  assert.equal(ctx.firstSeen, "2026-05-24T00:00:00.000Z");
  assert.equal(ctx.lastSeen, "2026-05-24T01:00:00.000Z");
  // The full log/trace shape is passed through untouched so the agent can walk
  // to live telemetry via the trace_id / span_id.
  assert.deepEqual(ctx.sample, sample);
  assert.equal(ctx.sample?.traceId, "abc123");
});

test("issue context tolerates issues that never captured a sample", () => {
  const ctx = toIssueContext({ ...baseIssue(), lastSample: null });
  assert.equal(ctx.sample, null);
});

function baseIssue(): Issue {
  return {
    id: "issue-1",
    projectId: "project-1",
    fingerprint: "fp-1",
    kind: "span",
    service: "api",
    exceptionType: "TypeError",
    title: "TypeError in checkout",
    message: "boom",
    topFrame: "checkout.ts:42",
    normalizedFrames: ["checkout.ts:42"],
    lastSample: null,
    firstSeen: new Date("2026-05-24T00:00:00.000Z"),
    lastSeen: new Date("2026-05-24T01:00:00.000Z"),
    status: "open",
    silencedAt: null,
    escalationTrigger: null,
    observationStartedAt: null,
    observationBaselineEventCount: null,
    observationLastEvaluatedAt: null,
    observationLastEventCount: null,
    lastAlertedAt: null,
    slackMessageTs: null,
    eventCount: 12,
    groupingState: "grouped",
    groupingSource: null,
    groupingReason: null,
    groupingAttemptedAt: null,
    groupingAttemptCount: 0,
    createdAt: new Date("2026-05-24T00:00:00.000Z"),
  };
}
