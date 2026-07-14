import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { TERMINAL_OUTCOME_NUDGE_MARKER } from "../agent-outcome-tools.js";
import {
  isCompleteInvestigationAllowed,
  isSessionBusyError,
  mobileRegressionGateState,
  mobileRegressionGateTerminatedSummary,
  mobileRegressionRepairPrompt,
  needsMobileRegressionRepair,
  shouldDeferSteering,
  steerIdleRunnerWithPendingContext,
  terminalOutcomeNudgePrompt,
} from "./sync.js";

test("complete_investigation is rejected when an intervention is available", () => {
  const result = {
    state: "complete" as const,
    summary: "Findings ready.",
    completionKind: "investigation_complete" as const,
  };
  assert.equal(
    isCompleteInvestigationAllowed(result, {
      prPolicy: "always",
      githubConnected: true,
      approvalPromptsEnabled: false,
      approvalPromptToolsAvailable: false,
    }),
    false,
  );
  assert.equal(
    isCompleteInvestigationAllowed(result, {
      prPolicy: "never",
      githubConnected: true,
      approvalPromptsEnabled: true,
      approvalPromptToolsAvailable: true,
    }),
    false,
  );
  assert.equal(
    isCompleteInvestigationAllowed(result, {
      prPolicy: "on_ready_to_pr",
      githubConnected: false,
      approvalPromptsEnabled: false,
      approvalPromptToolsAvailable: true,
    }),
    true,
  );
});

test("steerIdleRunnerWithPendingContext steers idle sessions with joined context deltas", async () => {
  const steered: Array<{ sessionId: string; message: string }> = [];
  const processedIds: string[][] = [];
  const notifiedIncidents: string[] = [];

  const didSteer = await steerIdleRunnerWithPendingContext({
    snapshotStatus: "idle",
    pendingContextEvents: [
      { id: "evt-1", summary: "Issue A joined." },
      { id: "evt-2", summary: null },
      { id: "evt-3", summary: "Issue B joined." },
    ],
    runner: {
      async steer(sessionId, message) {
        steered.push({ sessionId, message });
      },
    },
    sessionId: "session-1",
    incidentId: "inc-1",
    async markEventsProcessed(ids) {
      processedIds.push(ids);
    },
    async notifySteered(incidentId) {
      notifiedIncidents.push(incidentId);
    },
  });

  assert.equal(didSteer, "steered");
  assert.deepEqual(steered, [
    { sessionId: "session-1", message: "Issue A joined.\nIssue B joined." },
  ]);
  assert.deepEqual(processedIds, [["evt-1", "evt-2", "evt-3"]]);
  assert.deepEqual(notifiedIncidents, ["inc-1"]);
});

test("steerIdleRunnerWithPendingContext waits unless the runner is idle with pending context", async () => {
  let steerCount = 0;
  const base = {
    runner: {
      async steer() {
        steerCount += 1;
      },
    },
    sessionId: "session-1",
    incidentId: "inc-1",
    async markEventsProcessed() {},
    async notifySteered() {},
  };

  assert.equal(
    await steerIdleRunnerWithPendingContext({
      ...base,
      snapshotStatus: "running",
      pendingContextEvents: [{ id: "evt-1", summary: "Issue joined." }],
    }),
    "not_applicable",
  );
  assert.equal(
    await steerIdleRunnerWithPendingContext({
      ...base,
      snapshotStatus: "idle",
      pendingContextEvents: [],
    }),
    "not_applicable",
  );
  assert.equal(steerCount, 0);
});

test("steerIdleRunnerWithPendingContext sends a fallback delta when summaries are empty", async () => {
  let message = "";

  const didSteer = await steerIdleRunnerWithPendingContext({
    snapshotStatus: "idle",
    pendingContextEvents: [{ id: "evt-1", summary: null }],
    runner: {
      async steer(_sessionId, nextMessage) {
        message = nextMessage;
      },
    },
    sessionId: "session-1",
    incidentId: "inc-1",
    async markEventsProcessed() {},
    async notifySteered() {},
  });

  assert.equal(didSteer, "steered");
  assert.equal(message, "New issues joined the incident.");
});

test("needsMobileRegressionRepair asks for a decision on Revyl-enabled mobile PRs", () => {
  assert.equal(
    needsMobileRegressionRepair({
      revylEnabled: true,
      service: "juno-mobile",
      result: {
        state: "complete",
        summary: "x",
        pr: {
          selectedRepoFullName: "MarshallBear1/chronic-care-chat",
          branchName: "superlog/fix-chat",
          baseBranch: "main",
          validationPassed: true,
          openStatus: "pending",
          changedFiles: ["app/app/chat.tsx"],
        },
      },
    }),
    true,
  );
});

test("needsMobileRegressionRepair allows created, skipped, or not-applicable decisions", () => {
  const base = {
    revylEnabled: true,
    service: "juno-mobile",
    result: {
      state: "complete" as const,
      summary: "x",
      pr: {
        selectedRepoFullName: "MarshallBear1/chronic-care-chat",
        branchName: "superlog/fix-chat",
        baseBranch: "main",
        validationPassed: true,
        openStatus: "pending" as const,
        changedFiles: ["app/app/chat.tsx"],
      },
    },
  };

  assert.equal(
    needsMobileRegressionRepair({
      ...base,
      result: {
        ...base.result,
        mobileRegressionTest: { status: "created", testId: "test_123" },
      },
    }),
    false,
  );
  assert.equal(
    needsMobileRegressionRepair({
      ...base,
      result: {
        ...base.result,
        mobileRegressionTest: {
          status: "skipped",
          reason: "No reliable UI flow.",
        },
      },
    }),
    false,
  );
  assert.equal(
    needsMobileRegressionRepair({
      ...base,
      result: {
        ...base.result,
        mobileRegressionTest: {
          status: "not_applicable",
          reason: "Backend-only.",
        },
      },
    }),
    false,
  );
});

test("needsMobileRegressionRepair ignores non-Revyl or non-mobile results", () => {
  const result = {
    state: "complete" as const,
    summary: "x",
    pr: {
      selectedRepoFullName: "org/repo",
      branchName: "superlog/fix",
      baseBranch: "main",
      validationPassed: true,
      openStatus: "pending" as const,
      changedFiles: ["server/chat.ts"],
    },
  };

  assert.equal(
    needsMobileRegressionRepair({
      revylEnabled: false,
      service: "juno-mobile",
      result,
    }),
    false,
  );
  assert.equal(needsMobileRegressionRepair({ revylEnabled: true, service: "api", result }), false);
  assert.equal(
    needsMobileRegressionRepair({
      revylEnabled: true,
      service: "api-mobile",
      result: { ...result, pr: null },
    }),
    false,
  );
});

test("mobileRegressionGateState defers when integration lookup fails for mobile PRs", () => {
  const result = {
    state: "complete" as const,
    summary: "x",
    pr: {
      selectedRepoFullName: "org/repo",
      branchName: "superlog/fix",
      baseBranch: "main",
      validationPassed: true,
      openStatus: "pending" as const,
      changedFiles: ["app/chat.tsx"],
    },
  };

  assert.equal(
    mobileRegressionGateState({
      toolLookup: "failed",
      service: "juno-mobile",
      result,
    }),
    "defer_lookup",
  );
  assert.equal(
    mobileRegressionGateState({
      toolLookup: "failed",
      service: "api",
      result: {
        ...result,
        pr: { ...result.pr, changedFiles: ["server/chat.ts"] },
      },
    }),
    "allow",
  );
});

test("mobileRegressionGateState repairs only when enabled mobile PRs lack a decision", () => {
  const result = {
    state: "complete" as const,
    summary: "x",
    pr: {
      selectedRepoFullName: "org/repo",
      branchName: "superlog/fix",
      baseBranch: "main",
      validationPassed: true,
      openStatus: "pending" as const,
      changedFiles: ["screens/chat.tsx"],
    },
  };

  assert.equal(
    mobileRegressionGateState({
      toolLookup: "enabled",
      service: "api",
      result,
    }),
    "repair",
  );
  assert.equal(
    mobileRegressionGateState({
      toolLookup: "disabled",
      service: "juno-mobile",
      result,
    }),
    "allow",
  );
  assert.equal(
    mobileRegressionGateState({
      toolLookup: "enabled",
      service: "juno-mobile",
      result: {
        ...result,
        mobileRegressionTest: { status: "created", testId: "test_123" },
      },
    }),
    "allow",
  );
});

test("mobileRegressionGateTerminatedSummary explains terminal repair failures", () => {
  assert.match(mobileRegressionGateTerminatedSummary("repair"), /required mobile regression/);
  assert.match(mobileRegressionGateTerminatedSummary("defer_lookup"), /could be checked/);
});

test("mobileRegressionRepairPrompt tells the agent exactly how to repair the result", () => {
  const prompt = mobileRegressionRepairPrompt();
  assert.match(prompt, /mobileTestStatus/);
  assert.match(prompt, /propose_pr/);
  assert.match(prompt, /revyl_validate_yaml/);
  assert.match(prompt, /revyl_create_test_from_yaml/);
});

test("shouldDeferSteering defers when collect just acked tool calls and there is no result", () => {
  // The snapshot's status was captured before the acks went out, so "idle"
  // is stale — the model is about to resume with the tool results. A steer
  // sent now is delivered AFTER the model's next event, which can be its
  // terminal outcome call; the turn reset on that message would discard it.
  assert.equal(shouldDeferSteering({ result: null, sentToolAckCount: 1 }), true);
  assert.equal(shouldDeferSteering({ result: null, sentToolAckCount: 3 }), true);
});

test("shouldDeferSteering defers when the dispatch pass just acked outcome tools", () => {
  // Dispatch-pass acks (action tools, the resolve_incident guard) unblock the
  // model exactly like collect-pass acks do, but they are not counted in
  // sentToolAckCount — the dispatch loop sends them before collect runs. A
  // steer sent in that window races the model's terminal outcome call.
  assert.equal(shouldDeferSteering({ result: null, dispatchedToolCallCount: 1 }), true);
  assert.equal(
    shouldDeferSteering({ result: null, sentToolAckCount: 0, dispatchedToolCallCount: 2 }),
    true,
  );
});

test("shouldDeferSteering does not defer settled or concluded snapshots", () => {
  // No acks sent: the idle status is genuine, steers are safe.
  assert.equal(shouldDeferSteering({ result: null, sentToolAckCount: 0 }), false);
  // Runners that never report the field keep today's behaviour.
  assert.equal(shouldDeferSteering({ result: null }), false);
  // A result landed: the run is concluding; the completion path owns it.
  assert.equal(
    shouldDeferSteering({ result: { state: "complete", summary: "x" }, sentToolAckCount: 1 }),
    false,
  );
  assert.equal(
    shouldDeferSteering({
      result: { state: "complete", summary: "x" },
      dispatchedToolCallCount: 1,
    }),
    false,
  );
});

test("terminalOutcomeNudgePrompt opens with the shared nudge marker", () => {
  // The marker is the contract runner backends use to recognize the worker's
  // own nudge in a session's event stream (redelivery detection here, and
  // turn-boundary exemption in stream-replaying runners). The prompt must
  // keep it as its exact first line.
  assert.equal(terminalOutcomeNudgePrompt().split("\n")[0], TERMINAL_OUTCOME_NUDGE_MARKER);
});

test("terminalOutcomeNudgePrompt names every outcome tool", () => {
  const prompt = terminalOutcomeNudgePrompt();
  for (const name of [
    "report_findings",
    "propose_pr",
    "report_external_cause",
    "resolve_incident",
    "ask_human",
  ]) {
    assert.ok(prompt.includes(name), `missing ${name}`);
  }
});

test("terminalOutcomeNudgePrompt uses complete_investigation when interventions are disabled", () => {
  const prompt = terminalOutcomeNudgePrompt({ completeInvestigationAvailable: true });
  assert.match(prompt, /complete_investigation/);
  assert.doesNotMatch(prompt, /propose_pr/);
});

test("isSessionBusyError matches the mid-flight steer rejection only", () => {
  assert.equal(
    isSessionBusyError(
      new Error(
        '400 {"type":"error","error":{"type":"invalid_request_error","message":"Invalid user.message event at events[0]: waiting on responses to events [sevt_x]; only `user.custom_tool_result` may be sent"}}',
      ),
    ),
    true,
  );
  assert.equal(isSessionBusyError(new Error("read ECONNRESET")), false);
});

test("steerIdleRunnerWithPendingContext skips (and keeps events pending) on a busy session", async () => {
  const processed: string[][] = [];
  const steered = await steerIdleRunnerWithPendingContext({
    snapshotStatus: "idle",
    pendingContextEvents: [{ id: "evt-1", summary: "Issue A joined." }],
    runner: {
      async steer() {
        throw new Error("400 ... waiting on responses to events [sevt_1] ...");
      },
    },
    sessionId: "session-1",
    incidentId: "inc-1",
    async markEventsProcessed(ids) {
      processed.push(ids);
    },
    async notifySteered() {
      throw new Error("must not notify when the steer was skipped");
    },
  });
  assert.equal(steered, "busy");
  assert.deepEqual(processed, []);
});
