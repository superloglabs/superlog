import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRunResult } from "@superlog/db";
import {
  agentResolveEventDedupeKey,
  resolutionCompletionCopy,
  resolutionCompletionResult,
  shouldUpdateResolutionMainMessage,
} from "./resolution-completion.js";

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

test("resolve dispatch and completion share one stable event key", () => {
  assert.equal(
    agentResolveEventDedupeKey("run-1"),
    "incident_resolved:agent_run:run-1:resolve_incident",
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
