import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRunResult } from "@superlog/db";
import {
  agentResolveEventDedupeKey,
  closedElsewhereCopyAfterNoiseRace,
  completionIntendsIncidentClosure,
  incidentAlreadyClosedCompletionCopy,
  legacyResolutionEventDedupeKey,
  mergedPullRequestResolutionCopy,
  settledPullRequestResolutionCopy,
  planLegacyTerminalResolutionCompletion,
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

test("settled-closed fallback publishes silenced copy when the cascade silenced issues", () => {
  const copy = settledPullRequestResolutionCopy({
    prNumber: 42,
    repoFullName: "acme/api",
    settledState: "closed",
    silenced: true,
  });

  assert.match(copy.threadLead, /closed without merging/);
  assert.match(copy.threadLead, /silenced/);
  assert.match(copy.threadLead, /Do not silence, resolve/);
  assert.equal(copy.status, "Incident resolved - errors silenced (agent PR closed)");
  assert.equal(copy.mainTextSuffix, "Incident resolved, errors silenced");
});

test("settled-closed fallback keeps plain copy when the committed resolution did not silence", () => {
  // Mixed merged+closed delivery: the triggering PR is a close, but a merged
  // sibling made the committed resolution agent_pr_merged with the plain
  // resolve cascade — the copy must not claim silencing.
  const copy = settledPullRequestResolutionCopy({
    prNumber: 42,
    repoFullName: "acme/api",
    settledState: "closed",
    silenced: false,
  });

  assert.doesNotMatch(copy.threadLead, /silenced/);
  assert.equal(copy.status, "Incident resolved - all agent pull requests settled");
  assert.equal(copy.mainTextSuffix, "Incident resolved");
});

test("settled-merged fallback keeps plain resolved copy", () => {
  const copy = settledPullRequestResolutionCopy({
    prNumber: 42,
    repoFullName: "acme/api",
    settledState: "merged",
    silenced: false,
  });

  assert.doesNotMatch(copy.threadLead, /silenced/);
  assert.equal(copy.mainTextSuffix, "Incident resolved");
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

test("legacy resolution and noise completion keep stable epoch proof keys", () => {
  assert.equal(
    legacyResolutionEventDedupeKey("run-1", "already_resolved"),
    "incident_resolved:agent_run:run-1:already_resolved",
  );
  assert.equal(
    legacyResolutionEventDedupeKey("run-1", "noise"),
    "incident_resolved:agent_run:run-1:noise",
  );
});

test("a PR-blocked legacy terminal result becomes a non-claiming completion", () => {
  const legacyResult: AgentRunResult = {
    state: "complete",
    summary: "The stale session classified the signal.",
    noiseClassification: {
      reason: "expected_probe",
      evidence: "The endpoint returned the documented response.",
    },
    resolutionClassification: {
      reason: "upstream_recovered",
      evidence: "The upstream signal disappeared.",
    },
    issueClassifications: [
      {
        issueId: "issue-1",
        action: "silence",
        reason: "The legacy action committed before the PR opened.",
        evidence: "The classification event is durable.",
      },
    ],
  };

  const plan = planLegacyTerminalResolutionCompletion(legacyResult, "pull_requests_open");

  assert.equal(plan.resolutionCommitted, false);
  assert.equal(plan.blocked, true);
  assert.equal(plan.shouldTerminateSession, false);
  assert.deepEqual(plan.result, {
    state: "complete",
    summary: legacyResult.summary,
    issueClassifications: legacyResult.issueClassifications,
  });
});

test("a successful legacy terminal resolution retains its verdict and retires the session", () => {
  const legacyResult: AgentRunResult = {
    state: "complete",
    summary: "The signal is expected.",
    noiseClassification: {
      reason: "expected_probe",
      evidence: "The response matches the documented probe behavior.",
    },
  };

  const plan = planLegacyTerminalResolutionCompletion(legacyResult, "resolved");

  assert.deepEqual(plan, {
    result: legacyResult,
    resolutionCommitted: true,
    blocked: false,
    shouldTerminateSession: true,
  });
});

test("a stale legacy run drops its Incident verdict and retires its obsolete session", () => {
  const legacyResult: AgentRunResult = {
    state: "complete",
    summary: "This snapshot belongs to the prior Incident epoch.",
    resolutionClassification: {
      reason: "upstream_recovered",
      evidence: "The old investigation observed a recovery.",
    },
  };

  const plan = planLegacyTerminalResolutionCompletion(legacyResult, "agent_run_not_current");

  assert.equal(plan.resolutionCommitted, false);
  assert.equal(plan.blocked, false);
  assert.equal(plan.shouldTerminateSession, true);
  assert.deepEqual(plan.result, {
    state: "complete",
    summary: legacyResult.summary,
  });

  const replayedDecision = planLegacyTerminalResolutionCompletion(
    legacyResult,
    "resolution_event_already_consumed",
  );
  assert.equal(replayedDecision.resolutionCommitted, false);
  assert.equal(replayedDecision.blocked, false);
  assert.equal(replayedDecision.shouldTerminateSession, true);
  assert.deepEqual(replayedDecision.result, plan.result);
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
