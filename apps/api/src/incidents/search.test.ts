import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Incident } from "@superlog/db";

// search.ts transitively imports the db client, which throws at import time
// without a connection string. Set a dummy URL before the dynamic import (the
// porsager client connects lazily, so these pure-function tests never open a
// socket). Same dynamic-import pattern as linear.test.ts / loops.test.ts.
process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";
const { resolveIncidentSearchStatus, toIncidentSummary } = await import("./search.js");

test("status defaults to hiding agent-classified noise", () => {
  assert.deepEqual(resolveIncidentSearchStatus(undefined), { kind: "exclude_noise" });
});

test("status='all' includes every status, noise included", () => {
  assert.deepEqual(resolveIncidentSearchStatus("all"), { kind: "all" });
});

test("a concrete status narrows to exactly that status", () => {
  assert.deepEqual(resolveIncidentSearchStatus("open"), { kind: "only", status: "open" });
  assert.deepEqual(resolveIncidentSearchStatus("autoresolved_noise"), {
    kind: "only",
    status: "autoresolved_noise",
  });
});

test("an unknown status is rejected rather than silently ignored", () => {
  assert.throws(() => resolveIncidentSearchStatus("bogus"), /invalid incident status/i);
});

test("summary is a compact, agent-friendly projection with ISO timestamps", () => {
  const summary = toIncidentSummary(baseIncident());

  assert.equal(summary.id, "incident-1");
  assert.equal(summary.projectId, "project-1");
  assert.equal(summary.codename, "steady-amber");
  assert.equal(summary.title, "Checkout failures");
  assert.equal(summary.service, "api");
  assert.equal(summary.environment, "production");
  assert.equal(summary.severity, "SEV-2");
  assert.equal(summary.status, "open");
  assert.equal(summary.issueCount, 1);
  assert.equal(summary.firstSeen, "2026-05-24T00:00:00.000Z");
  assert.equal(summary.lastSeen, "2026-05-24T01:00:00.000Z");
  assert.equal(summary.resolvedAt, null);
  // Heavy/internal columns must not leak into the MCP payload.
  assert.equal("noiseClassification" in summary, false);
  assert.equal("slackInstallationId" in summary, false);
});

test("summary surfaces agent findings and resolution metadata when present", () => {
  const summary = toIncidentSummary({
    ...baseIncident(),
    status: "resolved",
    agentSummary: "DB pool exhausted",
    rootCauseText: "connection leak in checkout handler",
    rootCauseConfidence: 80,
    resolvedAt: new Date("2026-05-25T00:00:00.000Z"),
    resolvedReasonCode: "agent_pr_merged",
  });

  assert.equal(summary.agentSummary, "DB pool exhausted");
  assert.equal(summary.rootCauseText, "connection leak in checkout handler");
  assert.equal(summary.rootCauseConfidence, 80);
  assert.equal(summary.resolvedAt, "2026-05-25T00:00:00.000Z");
  assert.equal(summary.resolvedReasonCode, "agent_pr_merged");
});

function baseIncident(): Incident {
  return {
    id: "incident-1",
    projectId: "project-1",
    service: "api",
    environment: "production",
    title: "Checkout failures",
    codename: "steady-amber",
    severity: "SEV-2",
    status: "open",
    noiseReason: null,
    noiseResolvedAt: null,
    mergedAt: null,
    slackInstallationId: null,
    lastSlackPostedAt: null,
    firstSeen: new Date("2026-05-24T00:00:00.000Z"),
    lastSeen: new Date("2026-05-24T01:00:00.000Z"),
    issueCount: 1,
    slackChannelId: null,
    slackThreadTs: null,
    autoInvestigateSuppressedUntil: null,
    autorecoveryLastEvaluatedAt: null,
    agentSummary: null,
    rootCauseText: null,
    rootCauseConfidence: null,
    estimatedImpactText: null,
    estimatedImpactConfidence: null,
    suggestedSeverity: null,
    noiseClassification: null,
    resolutionClassification: null,
    findingsAgentRunId: null,
    resolvedByKind: null,
    resolvedByUserId: null,
    resolvedBySlackUserId: null,
    resolvedReasonCode: null,
    resolvedReasonText: null,
    resolvedAt: null,
    mergedIntoId: null,
      previousIncidentId: null,
    createdAt: new Date("2026-05-24T00:00:00.000Z"),
    updatedAt: new Date("2026-05-24T00:00:00.000Z"),
  };
}
