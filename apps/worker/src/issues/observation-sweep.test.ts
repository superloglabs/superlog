import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { schema } from "@superlog/db";
import { type ObservationSweepDeps, runObservationSweep } from "./observation-sweep.js";

const NOW = new Date("2026-07-06T12:00:00Z");

function makeObservedIssue(overrides: Partial<schema.Issue> = {}): schema.Issue {
  return {
    id: "iss-1",
    projectId: "proj-1",
    fingerprint: "fp",
    kind: "log",
    status: "under_observation",
    title: "residual auth errors",
    eventCount: 100,
    escalationTrigger: { kind: "count", count: 50 },
    observationStartedAt: new Date(NOW.getTime() - 60 * 60_000),
    observationBaselineEventCount: 80,
    observationLastEvaluatedAt: null,
    observationLastEventCount: null,
    lastSeen: NOW,
    firstSeen: NOW,
    ...overrides,
  } as schema.Issue;
}

function makeDeps(opts: {
  issues: schema.Issue[];
  calls: string[];
  now?: Date;
}): ObservationSweepDeps {
  return {
    async listUnderObservation() {
      return opts.issues;
    },
    async recordEvaluation(issueId, _at, eventCount) {
      opts.calls.push(`recordEvaluation:${issueId}:${eventCount}`);
    },
    async escalate(issue) {
      opts.calls.push(`escalate:${issue.id}`);
    },
    logger: {
      info() {},
      warn(obj, msg) {
        opts.calls.push(`warn:${msg ?? ""}:${String(obj.issue_id ?? "")}`);
      },
      error(obj, msg) {
        opts.calls.push(`error:${msg ?? ""}:${String(obj.issue_id ?? "")}`);
      },
    },
    now: () => opts.now ?? NOW,
  };
}

test("count trigger escalates once growth passes the baseline threshold", async () => {
  const calls: string[] = [];
  const escalated = await runObservationSweep(
    makeDeps({
      calls,
      issues: [
        makeObservedIssue({ id: "iss-under", eventCount: 129 }),
        makeObservedIssue({ id: "iss-over", eventCount: 130 }),
      ],
    }),
  );
  assert.equal(escalated, 1);
  assert.ok(calls.includes("escalate:iss-over"));
  assert.ok(!calls.includes("escalate:iss-under"));
});

test("rate trigger anchors on first pass, then fires on the delta rate", async () => {
  const calls: string[] = [];
  const rateIssue = makeObservedIssue({
    id: "iss-rate",
    escalationTrigger: { kind: "rate", perMinute: 4 },
    eventCount: 500,
  });
  // First pass: no prior evaluation → anchor, no escalation.
  let escalated = await runObservationSweep(makeDeps({ calls, issues: [rateIssue] }));
  assert.equal(escalated, 0);
  assert.ok(calls.includes("recordEvaluation:iss-rate:500"));

  // Second pass, 5 minutes later, 30 new events → 6/min ≥ 4/min → fires.
  const anchored = makeObservedIssue({
    id: "iss-rate",
    escalationTrigger: { kind: "rate", perMinute: 4 },
    eventCount: 530,
    observationLastEvaluatedAt: NOW,
    observationLastEventCount: 500,
  });
  escalated = await runObservationSweep(
    makeDeps({
      calls,
      issues: [anchored],
      now: new Date(NOW.getTime() + 5 * 60_000),
    }),
  );
  assert.equal(escalated, 1);
  assert.ok(calls.includes("escalate:iss-rate"));
});

test("rate trigger below threshold slides the window instead of firing", async () => {
  const calls: string[] = [];
  const quiet = makeObservedIssue({
    id: "iss-quiet",
    escalationTrigger: { kind: "rate", perMinute: 4 },
    eventCount: 505,
    observationLastEvaluatedAt: NOW,
    observationLastEventCount: 500,
  });
  const escalated = await runObservationSweep(
    makeDeps({
      calls,
      issues: [quiet],
      now: new Date(NOW.getTime() + 6 * 60_000),
    }),
  );
  assert.equal(escalated, 0);
  assert.ok(calls.includes("recordEvaluation:iss-quiet:505"));
  assert.ok(!calls.some((c) => c.startsWith("escalate:")));
});

test("issue without a trigger is skipped with a warning", async () => {
  const calls: string[] = [];
  const escalated = await runObservationSweep(
    makeDeps({
      calls,
      issues: [makeObservedIssue({ id: "iss-broken", escalationTrigger: null })],
    }),
  );
  assert.equal(escalated, 0);
  assert.ok(calls.some((c) => c.startsWith("warn:") && c.includes("iss-broken")));
});

test("a throwing issue is isolated and the sweep continues", async () => {
  const calls: string[] = [];
  const deps = makeDeps({
    calls,
    issues: [
      makeObservedIssue({ id: "iss-poison", eventCount: 200 }),
      makeObservedIssue({ id: "iss-fine", eventCount: 200 }),
    ],
  });
  const originalEscalate = deps.escalate;
  deps.escalate = async (issue) => {
    if (issue.id === "iss-poison") throw new Error("boom");
    return originalEscalate(issue);
  };
  const escalated = await runObservationSweep(deps);
  assert.equal(escalated, 1);
  assert.ok(calls.includes("escalate:iss-fine"));
  assert.ok(calls.some((c) => c.startsWith("error:") && c.includes("iss-poison")));
});
