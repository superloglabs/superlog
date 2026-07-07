import assert from "node:assert/strict";
import test from "node:test";
import {
  buildIncidentDetailMeta,
  formatIncidentDuration,
  incidentDisplayStatus,
} from "./incident-detail-view-model.ts";

const incident = {
  id: "inc_1",
  projectId: "p1",
  service: "superlog-api",
  environment: "production",
  title: "Cloudflare integration setup fails",
  codename: "opal-tanuki",
  severity: "SEV-2" as const,
  status: "open",
  noiseReason: null,
  noiseResolvedAt: null,
  firstSeen: "2026-06-30T16:39:01.388Z",
  lastSeen: "2026-06-30T16:41:30.000Z",
  issueCount: 1,
  slackChannelId: null,
  slackThreadTs: null,
  agentSummary: "summary",
  rootCauseText: null,
  rootCauseConfidence: null,
  estimatedImpactText: null,
  estimatedImpactConfidence: null,
  suggestedSeverity: null,
  noiseClassification: null,
  resolutionClassification: null,
  findingsAgentRunId: null,
  createdAt: "2026-06-30T16:39:01.388Z",
  updatedAt: "2026-06-30T17:01:30.633Z",
};

test("incidentDisplayStatus uses active language for open incidents", () => {
  assert.equal(incidentDisplayStatus("open", false), "Active");
  assert.equal(incidentDisplayStatus("resolved", false), "Resolved");
  assert.equal(incidentDisplayStatus("autoresolved_noise", false), "Noise");
  assert.equal(incidentDisplayStatus("open", true), "Recovery detected");
});

test("formatIncidentDuration formats compact elapsed time", () => {
  assert.equal(
    formatIncidentDuration("2026-06-30T16:39:01.388Z", "2026-06-30T17:01:30.633Z"),
    "22 min 29 s",
  );
});

test("buildIncidentDetailMeta returns one sidebar row list without duplicating the title", () => {
  const meta = buildIncidentDetailMeta({
    incident,
    issueCount: 1,
    agentRunState: "complete",
    pendingRecovery: false,
  });

  assert.deepEqual(
    meta.map((row) => [row.label, row.value]),
    [
      ["Priority", "SEV-2"],
      ["Status", "Active"],
      ["Service", "superlog-api"],
      ["Environment", "production"],
      ["First detection", "Jun 30, 16:39 UTC"],
      ["Latest detection", "Jun 30, 16:41 UTC"],
      ["Duration", "2 min 29 s"],
      ["Findings", "1 finding"],
      ["Agent run", "complete"],
    ],
  );
});
