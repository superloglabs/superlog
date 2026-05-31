import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { steerIdleRunnerWithPendingContext } from "./sync.js";

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
