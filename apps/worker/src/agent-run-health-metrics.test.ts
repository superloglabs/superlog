import "./agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AgentRunOrgHealthCounts,
  buildAgentRunHealthObservations,
  withRecoveryZeros,
} from "./agent-run-health-metrics.js";

const ACME: AgentRunOrgHealthCounts = {
  orgId: "org-acme",
  orgName: "Acme",
  failedRecentByReason: { patch_validation_failed: 7, sync_failed: 2 },
  completedRecent: 31,
  stuck: 4,
  queued: 12,
  awaitingHuman: 3,
  awaitingEvents: 2,
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
  awaitingEvents: 0,
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
  assert.equal(byKey.get("superlog.agent_runs.awaiting_events|Acme|"), 2);
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

test("orgs that drop out of the snapshot get one explicit all-zero pass", () => {
  // Globex emitted last pass but has nothing to report now (e.g. its only
  // stuck run got superseded). It must emit zeros once so its series ends at
  // 0 instead of freezing at the last bad value.
  const previous = new Map([
    ["org-acme", "Acme"],
    ["org-globex", "Globex"],
  ]);
  const out = withRecoveryZeros([ACME], previous);
  assert.equal(out.length, 2);
  const globex = out.find((o) => o.orgId === "org-globex");
  assert.ok(globex);
  assert.equal(globex.orgName, "Globex");
  assert.equal(globex.stuck, 0);
  assert.equal(globex.queued, 0);
  assert.equal(globex.awaitingEvents, 0);
  assert.equal(globex.blocked, 0);
  assert.deepEqual(globex.failedRecentByReason, {});
  // Orgs still present are passed through untouched.
  assert.equal(out.find((o) => o.orgId === "org-acme"), ACME);
});

test("no orgs at all still observes every gauge so the series never goes dark", () => {
  const observations = buildAgentRunHealthObservations([]);
  const metrics = observations.map((o) => o.metric);
  for (const m of [
    "superlog.agent_runs.stuck",
    "superlog.agent_runs.queued",
    "superlog.agent_runs.awaiting_human",
    "superlog.agent_runs.awaiting_events",
    "superlog.agent_runs.blocked",
    "superlog.agent_runs.completed_recent",
    "superlog.agent_runs.failed_recent",
  ]) {
    assert.ok(metrics.includes(m), `missing ${m}`);
  }
  for (const o of observations) assert.equal(o.value, 0);
});
