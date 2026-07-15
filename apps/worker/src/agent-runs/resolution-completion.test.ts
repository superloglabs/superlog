import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRunResult } from "@superlog/db";
import {
  agentResolveEventDedupeKey,
  closedElsewhereCopyAfterNoiseRace,
  completionIntendsIncidentClosure,
  incidentAlreadyClosedCompletionCopy,
  mergedPullRequestResolutionCopy,
  resolutionCompletionCopy,
  resolutionCompletionResult,
  shouldRetireProviderSession,
  shouldUpdateResolutionMainMessage,
  supersededSnapshotCompletionResult,
} from "./resolution-completion.js";

test("noise and resolution completions retire their provider session without an explicit outcome", () => {
  assert.equal(
    completionIntendsIncidentClosure({
      hasIncidentOutcome: false,
      noiseReason: "not_actionable",
      resolutionReason: null,
    }),
    true,
  );
  assert.equal(
    completionIntendsIncidentClosure({
      hasIncidentOutcome: false,
      noiseReason: null,
      resolutionReason: "fixed_in_current_code",
    }),
    true,
  );
  assert.equal(
    completionIntendsIncidentClosure({
      hasIncidentOutcome: true,
      noiseReason: null,
      resolutionReason: null,
    }),
    true,
  );
  assert.equal(
    completionIntendsIncidentClosure({
      hasIncidentOutcome: false,
      noiseReason: null,
      resolutionReason: null,
    }),
    false,
  );
});

test("a manual resolution that wins before noise metadata suppresses generic completion copy", () => {
  assert.deepEqual(
    closedElsewhereCopyAfterNoiseRace({
      noiseReason: "not_actionable",
      noiseApplied: false,
      incidentStatus: "resolved",
    }),
    incidentAlreadyClosedCompletionCopy(),
  );
  assert.equal(
    closedElsewhereCopyAfterNoiseRace({
      noiseReason: "not_actionable",
      noiseApplied: false,
      incidentStatus: "open",
    }),
    null,
  );
  assert.equal(
    closedElsewhereCopyAfterNoiseRace({
      noiseReason: "not_actionable",
      noiseApplied: true,
      incidentStatus: "resolved",
    }),
    null,
  );
});

test("merged fallback publishes Incident-resolved copy", () => {
  const copy = mergedPullRequestResolutionCopy({
    prNumber: 42,
    repoFullName: "acme/api",
  });

  assert.deepEqual(copy, {
    threadLead:
      ":white_check_mark: All agent pull requests are merged; incident resolved by PR #42 (acme/api).",
    status: "Incident resolved - all agent pull requests merged",
    mainTextSuffix: "Incident resolved",
  });
  assert.doesNotMatch(`${copy.threadLead} ${copy.status}`, /investigation complete/i);
});

test("merged fallback that loses the resolution race uses thread-only closed-elsewhere copy", () => {
  const copy = incidentAlreadyClosedCompletionCopy();

  assert.deepEqual(copy, {
    logMessage: "agent run complete after incident closed by another path",
    threadLead:
      ":white_check_mark: Investigation finished after this incident was closed by another path.",
    status: "Incident closed outside this run",
    updateMainMessage: false,
  });
  assert.doesNotMatch(`${copy.threadLead} ${copy.status}`, /investigation complete/i);
});

const result: AgentRunResult = {
  state: "complete",
  summary: "Found and classified the failure.",
  rootCauseConfidence: "high",
  issueClassifications: [
    {
      issueId: "issue-1",
      action: "resolve",
      reason: "The broken code was removed.",
      evidence: "The current deployment no longer reaches it.",
    },
  ],
  incidentResolution: {
    reason: "The incident no longer needs action.",
    evidence: "The failing path is absent from the current code.",
  },
  incidentResolutionEventDedupeKey: "incident_resolved:agent_run:run-1:resolve_incident:tool-use-1",
};

test("a run that committed the resolution retains its classifications", () => {
  assert.deepEqual(resolutionCompletionResult(result, true), result);
});

test("a run that lost the resolution race persists findings without phantom classifications", () => {
  assert.deepEqual(resolutionCompletionResult(result, false), {
    state: "complete",
    summary: "Found and classified the failure.",
    rootCauseConfidence: "high",
  });
});

test("an externally completed nonterminal snapshot is normalized for durable reconciliation", () => {
  assert.deepEqual(
    supersededSnapshotCompletionResult({
      state: "awaiting_human",
      summary: "I still found the failing dependency.",
      question: "Which region failed?",
      rootCauseConfidence: "medium",
    }),
    {
      state: "complete",
      summary: "I still found the failing dependency.",
      question: "Which region failed?",
      rootCauseConfidence: "medium",
    },
  );
});

test("provider sessions retire only after the Incident becomes terminal", () => {
  assert.equal(shouldRetireProviderSession("open"), false);
  assert.equal(shouldRetireProviderSession("resolved"), true);
  assert.equal(shouldRetireProviderSession("merged"), true);
  assert.equal(shouldRetireProviderSession("autoresolved_noise"), true);
});

test("resolve dispatch and completion share one stable event key", () => {
  assert.equal(
    agentResolveEventDedupeKey("run-1", "tool-use-1"),
    "incident_resolved:agent_run:run-1:resolve_incident:tool-use-1",
  );
  assert.notEqual(
    agentResolveEventDedupeKey("run-1", "tool-use-1"),
    agentResolveEventDedupeKey("run-1", "tool-use-2"),
  );
});

test("a competing resolution is not attributed to this run", () => {
  const resolution = result.incidentResolution;
  assert.ok(resolution);
  const copy = resolutionCompletionCopy(false, resolution.reason);

  assert.equal(
    copy.threadLead,
    ":white_check_mark: Investigation finished after this incident was closed by another path.",
  );
  assert.equal(copy.status, "Incident closed outside this run");
  assert.doesNotMatch(
    `${copy.logMessage} ${copy.threadLead} ${copy.status}`,
    /resolved|by the agent/i,
  );
  assert.equal(shouldUpdateResolutionMainMessage(false), false);
  assert.equal(shouldUpdateResolutionMainMessage(true), true);
});
