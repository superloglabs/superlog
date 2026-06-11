import "./agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AgentRunOrgHealthCounts,
  buildAgentRunHealthObservations,
} from "./agent-run-health-metrics.js";

const ACME: AgentRunOrgHealthCounts = {
  orgId: "org-acme",
  orgName: "Acme",
  failedRecentByReason: { patch_validation_failed: 7, sync_failed: 2 },
  completedRecent: 31,
  stuck: 4,
  queued: 12,
  awaitingHuman: 3,
  blocked: 5,
};

const GLOBEX: AgentRunOrgHealthCounts = {
  orgId: "org-globex",
  orgName: "Globex",
  failedRecentByReason: {},
  completedRecent: 0,
  stuck: 0,
  queued: 1,
  awaitingHuman: 0,
  blocked: 0,
};

function key(o: { metric: string; attributes?: Record<string, string> }): string {
  return [
    o.metric,
    o.attributes?.["tenant.org.name"] ?? "",
    o.attributes?.["failure.reason"] ?? "",
  ].join("|");
}

test("per-org counts map onto gauges with tenant org attributes", () => {
  const observations = buildAgentRunHealthObservations([ACME, GLOBEX]);
  const byKey = new Map(observations.map((o) => [key(o), o.value]));

  assert.equal(byKey.get("superlog.agent_runs.stuck|Acme|"), 4);
  assert.equal(byKey.get("superlog.agent_runs.queued|Acme|"), 12);
  assert.equal(byKey.get("superlog.agent_runs.awaiting_human|Acme|"), 3);
  assert.equal(byKey.get("superlog.agent_runs.blocked|Acme|"), 5);
  assert.equal(byKey.get("superlog.agent_runs.completed_recent|Acme|"), 31);
  assert.equal(byKey.get("superlog.agent_runs.failed_recent|Acme|patch_validation_failed"), 7);
  assert.equal(byKey.get("superlog.agent_runs.failed_recent|Acme|sync_failed"), 2);

  // Zero gauges still emit per org so a recovered org drops to 0 instead of
  // its series freezing at the last bad value.
  assert.equal(byKey.get("superlog.agent_runs.stuck|Globex|"), 0);
  assert.equal(byKey.get("superlog.agent_runs.queued|Globex|"), 1);

  // Both org id and name ride along for grouping/filtering.
  const acmeStuck = observations.find((o) => key(o) === "superlog.agent_runs.stuck|Acme|");
  assert.equal(acmeStuck?.attributes?.["tenant.org.id"], "org-acme");
});

test("zero failures across all orgs still observe an explicit failed_recent zero", () => {
  const observations = buildAgentRunHealthObservations([GLOBEX]);
  const failed = observations.filter((o) => o.metric === "superlog.agent_runs.failed_recent");
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.value, 0);
  assert.equal(failed[0]?.attributes?.["failure.reason"], "none");
});

test("no orgs at all still observes every gauge so the series never goes dark", () => {
  const observations = buildAgentRunHealthObservations([]);
  const metrics = observations.map((o) => o.metric);
  for (const m of [
    "superlog.agent_runs.stuck",
    "superlog.agent_runs.queued",
    "superlog.agent_runs.awaiting_human",
    "superlog.agent_runs.blocked",
    "superlog.agent_runs.completed_recent",
    "superlog.agent_runs.failed_recent",
  ]) {
    assert.ok(metrics.includes(m), `missing ${m}`);
  }
  for (const o of observations) assert.equal(o.value, 0);
});
