import assert from "node:assert/strict";
import test from "node:test";
import {
  buildIncidentDetailMeta,
  formatIncidentDuration,
  formatIncidentLocalTimestamp,
  incidentDisplayStatus,
  latestIncidentLinearTicket,
} from "./incident-detail-view-model.ts";

const now = Date.parse("2026-07-01T16:39:01.388Z");

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
  autoInvestigateBlockedReason: null,
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
    agentRunState: "complete",
    pendingRecovery: false,
    now,
  });

  // Linked issues renders as its own interactive sidebar row, not a meta row.
  assert.deepEqual(
    meta.map((row) => [row.label, row.value]),
    [
      ["Priority", "SEV-2"],
      ["Status", "Active"],
      ["Service", "superlog-api"],
      ["Environment", "production"],
      ["First detection", "1d ago"],
      ["Last detection", "23h ago"],
      ["Duration", "2 min 29 s"],
      ["Investigation", "complete"],
    ],
  );
});

test("buildIncidentDetailMeta shows a red 'out of credits' when a blocked incident has no run", () => {
  const meta = buildIncidentDetailMeta({
    incident: { ...incident, autoInvestigateBlockedReason: "no_credits" },
    agentRunState: null,
    pendingRecovery: false,
  });

  const row = meta.find((r) => r.label === "Investigation");
  assert.equal(row?.value, "Out of credits");
  assert.equal(row?.tone, "danger");
});

test("buildIncidentDetailMeta shows 'not queued' with no emphasis when nothing blocked the run", () => {
  const meta = buildIncidentDetailMeta({
    incident,
    agentRunState: null,
    pendingRecovery: false,
  });

  const row = meta.find((r) => r.label === "Investigation");
  assert.equal(row?.value, "not queued");
  assert.equal(row?.tone, undefined);
});

test("buildIncidentDetailMeta prefers the actual run state over a stale block reason", () => {
  const meta = buildIncidentDetailMeta({
    incident: { ...incident, autoInvestigateBlockedReason: "no_credits" },
    agentRunState: "complete",
    pendingRecovery: false,
  });

  const row = meta.find((r) => r.label === "Investigation");
  assert.equal(row?.value, "complete");
  assert.equal(row?.tone, undefined);
});

test("buildIncidentDetailMeta formats midnight UTC with hour zero", () => {
  const meta = buildIncidentDetailMeta({
    incident: {
      ...incident,
      firstSeen: "2026-06-30T00:05:00.000Z",
      lastSeen: "2026-06-30T00:06:00.000Z",
    },
    agentRunState: "complete",
    pendingRecovery: false,
    now,
  });

  assert.equal(meta.find((row) => row.label === "First detection")?.value, "1d ago");
  assert.equal(meta.find((row) => row.label === "Last detection")?.value, "1d ago");
});

test("formatIncidentLocalTimestamp uses the visitor's timezone", () => {
  assert.equal(
    formatIncidentLocalTimestamp("2026-06-30T16:39:01.388Z", {
      locale: "en-US",
      timeZone: "America/Los_Angeles",
    }),
    "Jun 30, 2026, 09:39 PDT",
  );
});

test("latestIncidentLinearTicket selects the newest recorded ticket for the sidebar", () => {
  const latest = latestIncidentLinearTicket([
    {
      id: "row-1",
      agentRunId: "run-1",
      identifier: "ENG-41",
      url: "https://linear.app/acme/issue/ENG-41",
      state: "In Progress",
      stateType: "started",
      createdAt: "2026-07-01T10:00:00.000Z",
    },
    {
      id: "row-2",
      agentRunId: "run-2",
      identifier: "ENG-42",
      url: "https://linear.app/acme/issue/ENG-42",
      state: "Todo",
      stateType: "unstarted",
      createdAt: "2026-07-02T10:00:00.000Z",
    },
  ]);

  assert.equal(latest?.identifier, "ENG-42");
  assert.equal(latestIncidentLinearTicket([]), null);
});
