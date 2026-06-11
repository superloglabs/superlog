import "./agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AgentRunHealthCounts,
  buildAgentRunHealthObservations,
} from "./agent-run-health-metrics.js";

const COUNTS: AgentRunHealthCounts = {
  failedRecentByReason: { patch_validation_failed: 7, sync_failed: 2 },
  completedRecent: 31,
  stuck: 4,
  queued: 12,
  awaitingHuman: 3,
};

test("health counts map onto the agent_runs gauges", () => {
  const observations = buildAgentRunHealthObservations(COUNTS);

  const byMetric = new Map(
    observations.map((o) => [`${o.metric}|${o.attributes?.["failure.reason"] ?? ""}`, o.value]),
  );
  assert.equal(byMetric.get("superlog.agent_runs.stuck|"), 4);
  assert.equal(byMetric.get("superlog.agent_runs.queued|"), 12);
  assert.equal(byMetric.get("superlog.agent_runs.awaiting_human|"), 3);
  assert.equal(byMetric.get("superlog.agent_runs.completed_recent|"), 31);
  assert.equal(byMetric.get("superlog.agent_runs.failed_recent|patch_validation_failed"), 7);
  assert.equal(byMetric.get("superlog.agent_runs.failed_recent|sync_failed"), 2);
});

test("zero failures still observe gauges so the series never goes dark", () => {
  const observations = buildAgentRunHealthObservations({
    failedRecentByReason: {},
    completedRecent: 0,
    stuck: 0,
    queued: 0,
    awaitingHuman: 0,
  });
  const metrics = observations.map((o) => o.metric);
  assert.ok(metrics.includes("superlog.agent_runs.stuck"));
  assert.ok(metrics.includes("superlog.agent_runs.queued"));
  // A zero-failure pass emits an explicit zero (no reason attribute) so charts
  // drop to 0 instead of holding the last bad value.
  const failed = observations.find((o) => o.metric === "superlog.agent_runs.failed_recent");
  assert.ok(failed);
  assert.equal(failed.value, 0);
  assert.equal(failed.attributes?.["failure.reason"], "none");
});
