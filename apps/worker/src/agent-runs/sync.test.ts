import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mobileRegressionRepairPrompt,
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

  assert.equal(didSteer, true);
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
    false,
  );
  assert.equal(
    await steerIdleRunnerWithPendingContext({
      ...base,
      snapshotStatus: "idle",
      pendingContextEvents: [],
    }),
    false,
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

  assert.equal(didSteer, true);
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

test("mobileRegressionRepairPrompt tells the agent exactly how to repair the result", () => {
  const prompt = mobileRegressionRepairPrompt();
  assert.match(prompt, /mobileRegressionTest/);
  assert.match(prompt, /revyl_validate_yaml/);
  assert.match(prompt, /revyl_create_test_from_yaml/);
  assert.match(prompt, /Do not resubmit/);
});
