import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  incidentHasFindings,
  resolveIncidentDetailTab,
  visibleIncidentDetailTabs,
} from "./incidents/incident-detail-tabs.ts";

const EMPTY_INCIDENT = {
  agentSummary: null,
  rootCauseText: null,
  estimatedImpactText: null,
  resolutionClassification: null,
};

test("an incident with no run and no findings only shows the Activity tab", () => {
  assert.equal(
    incidentHasFindings({
      incident: EMPTY_INCIDENT,
      agentRun: null,
      hasPendingResolutionProposal: false,
    }),
    false,
  );
  assert.deepEqual(visibleIncidentDetailTabs({ hasFindings: false, hasPullRequests: false }), [
    "activity",
  ]);
});

test("a run that is still investigating (null result) records no findings yet", () => {
  assert.equal(
    incidentHasFindings({
      incident: EMPTY_INCIDENT,
      agentRun: { failureReason: null, result: null },
      hasPendingResolutionProposal: false,
    }),
    false,
  );
});

test("flattened incident findings surface the Findings tab", () => {
  assert.equal(
    incidentHasFindings({
      incident: { ...EMPTY_INCIDENT, agentSummary: "Null deref in cart add" },
      agentRun: null,
      hasPendingResolutionProposal: false,
    }),
    true,
  );
  assert.deepEqual(visibleIncidentDetailTabs({ hasFindings: true, hasPullRequests: false }), [
    "activity",
    "findings",
  ]);
});

test("run-result findings count before the incident columns are backfilled", () => {
  assert.equal(
    incidentHasFindings({
      incident: EMPTY_INCIDENT,
      agentRun: { failureReason: null, result: { summary: "Found the bug" } },
      hasPendingResolutionProposal: false,
    }),
    true,
  );
});

test("malformed result fields do not count as findings", () => {
  // AgentRunView renders nothing for these shapes (see isConfidenceField),
  // so counting them would surface an empty Findings tab.
  assert.equal(
    incidentHasFindings({
      incident: EMPTY_INCIDENT,
      agentRun: {
        failureReason: null,
        result: {
          summary: "",
          rootCause: "a bare string instead of { text, confidence }",
          estimatedImpact: { text: "missing confidence" },
          resolutionClassification: "resolved",
        },
      },
      hasPendingResolutionProposal: false,
    }),
    false,
  );
});

test("well-formed result confidence fields count as findings", () => {
  assert.equal(
    incidentHasFindings({
      incident: EMPTY_INCIDENT,
      agentRun: {
        failureReason: null,
        result: { summary: "", rootCause: { text: "bad deploy", confidence: 0.8 } },
      },
      hasPendingResolutionProposal: false,
    }),
    true,
  );
});

test("an ask_human question surfaces the Findings tab", () => {
  assert.equal(
    incidentHasFindings({
      incident: EMPTY_INCIDENT,
      agentRun: { failureReason: null, result: { summary: "", question: "Which env?" } },
      hasPendingResolutionProposal: false,
    }),
    true,
  );
});

test("a failed run surfaces the Findings tab so the failure reason is reachable", () => {
  assert.equal(
    incidentHasFindings({
      incident: EMPTY_INCIDENT,
      agentRun: { failureReason: "pr_open_failed", result: null },
      hasPendingResolutionProposal: false,
    }),
    true,
  );
});

test("a pending resolution proposal surfaces the Findings tab", () => {
  assert.equal(
    incidentHasFindings({
      incident: EMPTY_INCIDENT,
      agentRun: null,
      hasPendingResolutionProposal: true,
    }),
    true,
  );
});

test("the PR tab only appears once a PR exists", () => {
  assert.deepEqual(visibleIncidentDetailTabs({ hasFindings: true, hasPullRequests: true }), [
    "activity",
    "findings",
    "pr",
  ]);
  assert.deepEqual(visibleIncidentDetailTabs({ hasFindings: false, hasPullRequests: true }), [
    "activity",
    "pr",
  ]);
});

test("a selected tab that is no longer visible falls back to Activity", () => {
  assert.equal(resolveIncidentDetailTab("pr", ["activity", "findings"]), "activity");
  assert.equal(resolveIncidentDetailTab("findings", ["activity", "findings"]), "findings");
  assert.equal(resolveIncidentDetailTab("activity", ["activity"]), "activity");
});
