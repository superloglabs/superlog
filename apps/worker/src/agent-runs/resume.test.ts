import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { resumeDurableAgentRun, resumeInputEventKinds } from "./resume.js";

test("external-cause waits resume when incident context changes", () => {
  assert.deepEqual(
    resumeInputEventKinds({
      state: "awaiting_events",
      result: {
        state: "awaiting_events",
        summary: "Waiting for the provider to recover.",
        waitReason: "external_cause",
      },
    }),
    ["human_reply", "incident_context_changed"],
  );
});

test("human waits still require a human reply", () => {
  assert.deepEqual(
    resumeInputEventKinds({
      state: "awaiting_human",
      result: {
        state: "awaiting_human",
        summary: "Which deployment should I inspect?",
      },
    }),
    ["human_reply"],
  );
});

test("external-cause context resumes with incident framing and consumes the input", async () => {
  const calls: string[] = [];
  const processed: string[][] = [];

  const outcome = await resumeDurableAgentRun({
    sessionId: "session-1",
    inputs: [
      {
        id: "event-1",
        kind: "incident_context_changed",
        summary: "New issue joined the incident (issue id: issue-2).",
        detail: null,
      },
    ],
    runner: {
      async resume() {
        calls.push("resume");
      },
      async steer(_sessionId, message) {
        calls.push(`steer:${message}`);
      },
    },
    async transitionToRunning() {
      calls.push("transition");
      return true;
    },
    async markProcessed(ids) {
      processed.push(ids);
    },
  });

  assert.equal(outcome, "resumed");
  assert.deepEqual(calls, [
    "steer:New issue joined the incident (issue id: issue-2).",
    "transition",
  ]);
  assert.deepEqual(processed, [["event-1"]]);
});

test("a resume accepted after a concurrent terminal transition does not reclaim the run", async () => {
  const calls: string[] = [];
  const processed: string[][] = [];

  const outcome = await resumeDurableAgentRun({
    sessionId: "session-1",
    inputs: [
      {
        id: "event-1",
        kind: "incident_context_changed",
        summary: "New issue joined the incident.",
        detail: null,
      },
    ],
    runner: {
      async resume() {
        calls.push("resume");
      },
      async steer() {
        calls.push("steer");
      },
    },
    async transitionToRunning() {
      calls.push("transition_lost");
      return false;
    },
    async markProcessed(ids) {
      processed.push(ids);
    },
  });

  assert.equal(outcome, "superseded");
  assert.deepEqual(calls, ["steer", "transition_lost"]);
  assert.deepEqual(processed, [["event-1"]]);
});

test("a human reply resumes first and leaves concurrent incident context for running sync", async () => {
  const delivered: Array<{ operation: string; message: string }> = [];
  const processed: string[][] = [];

  const outcome = await resumeDurableAgentRun({
    sessionId: "session-1",
    inputs: [
      {
        id: "context-1",
        kind: "incident_context_changed",
        summary: "New issue joined the incident.",
        detail: null,
      },
      {
        id: "reply-1",
        kind: "human_reply",
        summary: "The provider is healthy again.",
        detail: null,
      },
    ],
    runner: {
      async resume(_sessionId, message) {
        delivered.push({ operation: "resume", message });
      },
      async steer(_sessionId, message) {
        delivered.push({ operation: "steer", message });
      },
    },
    async transitionToRunning() {
      return true;
    },
    async markProcessed(ids) {
      processed.push(ids);
    },
  });

  assert.equal(outcome, "resumed");
  assert.deepEqual(delivered, [{ operation: "resume", message: "The provider is healthy again." }]);
  assert.deepEqual(processed, [["reply-1"]]);
});
