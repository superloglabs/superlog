import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  type IncidentListItemInput,
  buildIncidentListItem,
  shouldInlineIncidentListStats,
} from "./list.js";

test("incident list omits graph stats by default so slow telemetry cannot block the page", () => {
  const row = buildIncidentListItem(baseInput());

  assert.equal("buckets" in row, false);
  assert.equal("impactedUsers" in row, false);
  assert.equal("impactedUsersAvailable" in row, false);
  assert.equal("impactedUsersCapped" in row, false);
  assert.equal("windowDays" in row, false);
});

test("incident list can still inline graph stats when explicitly requested", () => {
  const row = buildIncidentListItem({
    ...baseInput(),
    stats: {
      windowDays: 14,
      buckets: [{ day: "2026-05-24", count: 4 }],
      impactedUsers: 3,
      impactedUsersAvailable: true,
      impactedUsersCapped: false,
    },
  });

  assert.deepEqual(row.buckets, [{ day: "2026-05-24", count: 4 }]);
  assert.equal(row.windowDays, 14);
  assert.equal(row.impactedUsers, 3);
  assert.equal(row.impactedUsersAvailable, true);
  assert.equal(row.impactedUsersCapped, false);
});

test("incident list only inlines graph stats behind an explicit query flag", () => {
  assert.equal(shouldInlineIncidentListStats(undefined), false);
  assert.equal(shouldInlineIncidentListStats(""), false);
  assert.equal(shouldInlineIncidentListStats("0"), false);
  assert.equal(shouldInlineIncidentListStats("true"), true);
  assert.equal(shouldInlineIncidentListStats("1"), true);
});

function baseInput(): IncidentListItemInput {
  return {
    incident: {
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
    },
    agentRun: null,
    pendingResolutionProposal: null,
  };
}
