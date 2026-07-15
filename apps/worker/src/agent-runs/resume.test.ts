import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  recoverUnresumableContinuation,
  resumeDurableAgentRun,
  resumeInputEventKinds,
} from "./resume.js";

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

test("an unresumable merged-PR continuation resolves before follow-up gates can drop it", async () => {
  const calls: string[] = [];
  const processed: string[][] = [];

  const outcome = await recoverUnresumableContinuation({
    inputs: [
      {
        id: "event-1",
        kind: "human_reply",
        summary: "PR #42 merged.",
        detail: {
          origin: {
            channel: "pr_merged",
            agentPrId: "agent-pr-42",
            author: "octocat",
            text: "PR #42 merged.",
            url: "https://github.com/acme/api/pull/42",
            occurredAt: "2026-07-15T10:00:00.000Z",
          },
        },
      },
    ],
    async resolveMergedPullRequest(input) {
      calls.push(`resolve:${input.agentPrId}`);
      return {
        disposition: "resolved",
        resolved: true,
        resolvedIssueCount: 1,
      };
    },
    async failCurrentRun() {
      calls.push("fail");
    },
    async requestFollowUp() {
      calls.push("follow_up_disabled_or_capped");
      return { outcome: "skipped", reason: "follow_up_cap_reached" };
    },
    async markProcessed(ids) {
      calls.push("mark_processed");
      processed.push(ids);
    },
  });

  assert.deepEqual(outcome, { kind: "resolved" });
  assert.deepEqual(calls, ["resolve:agent-pr-42", "mark_processed"]);
  assert.deepEqual(processed, [["event-1"]]);
});

test("an unresumable merged-PR continuation cold-starts while sibling PRs remain", async () => {
  const calls: string[] = [];
  const input = {
    id: "event-1",
    kind: "human_reply" as const,
    summary: "PR #42 merged.",
    detail: {
      origin: {
        channel: "pr_merged" as const,
        agentPrId: "agent-pr-42",
        author: "octocat",
        text: "PR #42 merged.",
        occurredAt: "2026-07-15T10:00:00.000Z",
      },
    },
  };

  const outcome = await recoverUnresumableContinuation({
    inputs: [input],
    async resolveMergedPullRequest() {
      calls.push("resolve");
      return {
        disposition: "pull_requests_pending",
        resolved: false,
        resolvedIssueCount: 0,
      };
    },
    async failCurrentRun() {
      calls.push("fail");
    },
    async requestFollowUp(interaction) {
      calls.push(`follow_up:${interaction.agentPrId}`);
      return { outcome: "skipped", reason: "auto_follow_up_disabled" };
    },
    async markProcessed(ids) {
      calls.push(`mark_processed:${ids.join(",")}`);
    },
  });

  assert.deepEqual(outcome, {
    kind: "cold_start",
    result: { outcome: "skipped", reason: "auto_follow_up_disabled" },
    inputText: "PR #42 merged.",
  });
  assert.deepEqual(calls, ["resolve", "fail", "follow_up:agent-pr-42", "mark_processed:event-1"]);
});

test("a merge-resolution failure leaves the continuation retryable", async () => {
  const sideEffects: string[] = [];

  await assert.rejects(
    recoverUnresumableContinuation({
      inputs: [
        {
          id: "event-1",
          kind: "human_reply",
          summary: "PR #42 merged.",
          detail: {
            origin: {
              channel: "pr_merged",
              agentPrId: "agent-pr-42",
              author: null,
              text: "PR #42 merged.",
              occurredAt: "2026-07-15T10:00:00.000Z",
            },
          },
        },
      ],
      async resolveMergedPullRequest() {
        throw new Error("database temporarily unavailable");
      },
      async failCurrentRun() {
        sideEffects.push("fail");
      },
      async requestFollowUp() {
        sideEffects.push("follow_up");
        return { outcome: "enqueued", agentRunId: "follow-up-1" };
      },
      async markProcessed() {
        sideEffects.push("mark_processed");
      },
    }),
    /database temporarily unavailable/,
  );
  assert.deepEqual(sideEffects, []);
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
