import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mobileRegressionGateState,
  mobileRegressionGateTerminatedSummary,
  isSessionBusyError,
  mobileRegressionRepairPrompt,
  terminalOutcomeNudgePrompt,
  needsMobileRegressionRepair,
  steerIdleRunnerWithPendingContext,
} from "./sync.js";

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

test("terminalOutcomeNudgePrompt names every terminal outcome tool", () => {
  const prompt = terminalOutcomeNudgePrompt();
  for (const name of [
    "propose_pr",
    "silence_as_noise",
    "place_under_observation",
    "mark_already_resolved",
    "complete_investigation",
    "ask_human",
    "report_failure",
  ]) {
    assert.ok(prompt.includes(name), `missing ${name}`);
  }
  assert.match(prompt, /exactly ONE/);
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
