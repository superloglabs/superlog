import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deliverResumeRepairingWedgedTurn,
  finalizeCurrentMergedPullRequestResolution,
  recoverUnresumableContinuation,
  resumeDurableAgentRun,
  resumeInputEventKinds,
} from "./resume.js";

test("a stale merged-PR proof cannot finalize or account another resolution epoch", async () => {
  const calls: string[] = [];

  const outcome = await finalizeCurrentMergedPullRequestResolution({
    disposition: "incident_not_open",
    async isCurrentResolution() {
      calls.push("proof");
      return false;
    },
    async accountResolution() {
      calls.push("account");
    },
    async finalizeRun() {
      calls.push("finalize");
    },
  });

  assert.equal(outcome, "stale");
  assert.deepEqual(calls, ["proof"]);
});

test("a current merged-PR proof republishes an incident-not-open retry without re-accounting", async () => {
  const calls: string[] = [];

  const outcome = await finalizeCurrentMergedPullRequestResolution({
    disposition: "incident_not_open",
    async isCurrentResolution() {
      calls.push("proof");
      return true;
    },
    async accountResolution() {
      calls.push("account");
    },
    async finalizeRun() {
      calls.push("finalize");
    },
  });

  assert.equal(outcome, "finalized");
  assert.deepEqual(calls, ["proof", "finalize"]);
});

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
    ["human_reply", "github_comment", "incident_context_changed"],
  );
});

test("interactive waits accept human replies and GitHub comments", () => {
  assert.deepEqual(
    resumeInputEventKinds({
      state: "awaiting_human",
      result: {
        state: "awaiting_human",
        summary: "Which deployment should I inspect?",
      },
    }),
    ["human_reply", "github_comment"],
  );
});

test("an unresumable merged-PR continuation resolves before follow-up gates can drop it", async () => {
  const calls: string[] = [];
  const processed: string[][] = [];
  let runState = "awaiting_events";

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
      runState = "complete";
      return {
        disposition: "resolved",
        resolved: true,
        resolvedIssueCount: 1,
      };
    },
    async publishResolvedRun(input, disposition) {
      assert.equal(runState, "complete");
      calls.push(`publish_and_account:${input.agentPrId}:${disposition}`);
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
  assert.deepEqual(calls, [
    "resolve:agent-pr-42",
    "publish_and_account:agent-pr-42:resolved",
    "mark_processed",
  ]);
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
    async publishResolvedRun() {
      calls.push("unexpected_publish");
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
      async publishResolvedRun() {
        sideEffects.push("publish");
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

test("a merged-resolution publication failure leaves the continuation retryable", async () => {
  const sideEffects: string[] = [];
  let resolveAttempts = 0;
  let publishAttempts = 0;
  const publicationDispositions: string[] = [];
  const inputs = [
    {
      id: "event-1",
      kind: "human_reply" as const,
      summary: "PR #42 merged.",
      detail: {
        origin: {
          channel: "pr_merged" as const,
          agentPrId: "agent-pr-42",
          author: null,
          text: "PR #42 merged.",
          occurredAt: "2026-07-15T10:00:00.000Z",
        },
      },
    },
  ];
  const dependencies = {
    inputs,
    async resolveMergedPullRequest() {
      resolveAttempts += 1;
      return resolveAttempts === 1
        ? ({
            disposition: "resolved",
            resolved: true,
            resolvedIssueCount: 1,
          } as const)
        : ({
            disposition: "incident_not_open",
            resolved: false,
            resolvedIssueCount: 0,
          } as const);
    },
    async publishResolvedRun(_input: unknown, disposition: "resolved" | "incident_not_open") {
      publishAttempts += 1;
      publicationDispositions.push(disposition);
      if (publishAttempts === 1) throw new Error("Slack temporarily unavailable");
    },
    async failCurrentRun() {
      sideEffects.push("fail");
    },
    async requestFollowUp() {
      sideEffects.push("follow_up");
      return { outcome: "enqueued" as const, agentRunId: "follow-up-1" };
    },
    async markProcessed(ids: string[]) {
      sideEffects.push(`mark_processed:${ids.join(",")}`);
    },
  };

  await assert.rejects(
    recoverUnresumableContinuation(dependencies),
    /Slack temporarily unavailable/,
  );
  assert.deepEqual(sideEffects, []);

  const retry = await recoverUnresumableContinuation(dependencies);

  assert.deepEqual(retry, { kind: "incident_not_open" });
  assert.equal(resolveAttempts, 2);
  assert.equal(publishAttempts, 2);
  assert.deepEqual(publicationDispositions, ["resolved", "incident_not_open"]);
  assert.deepEqual(sideEffects, ["mark_processed:event-1"]);
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

test("a wedged-turn delivery interrupts the open turn and retries in place", async () => {
  const calls: string[] = [];
  let attempts = 0;

  const delivery = await deliverResumeRepairingWedgedTurn({
    async attempt() {
      attempts += 1;
      calls.push(`attempt:${attempts}`);
      if (attempts === 1) throw new Error("waiting on responses to events [sevt_1]");
      return "resumed";
    },
    classifyError() {
      return "wedged_turn";
    },
    async interruptOpenTurn() {
      calls.push("interrupt");
    },
  });

  assert.deepEqual(delivery, { kind: "delivered", outcome: "resumed", repaired: true });
  assert.deepEqual(calls, ["attempt:1", "interrupt", "attempt:2"]);
});

test("a wedged turn without an interrupt capability fails without a retry", async () => {
  let attempts = 0;
  const err = new Error("waiting on responses to events [sevt_1]");

  const delivery = await deliverResumeRepairingWedgedTurn({
    async attempt() {
      attempts += 1;
      throw err;
    },
    classifyError() {
      return "wedged_turn";
    },
    interruptOpenTurn: null,
  });

  assert.deepEqual(delivery, {
    kind: "failed",
    err,
    errorKind: "wedged_turn",
    repairAttempted: false,
  });
  assert.equal(attempts, 1);
});

test("session-gone delivery errors are never repaired", async () => {
  const calls: string[] = [];
  const err = new Error("404 session not found");

  const delivery = await deliverResumeRepairingWedgedTurn({
    async attempt() {
      calls.push("attempt");
      throw err;
    },
    classifyError() {
      return "session_gone";
    },
    async interruptOpenTurn() {
      calls.push("interrupt");
    },
  });

  assert.deepEqual(delivery, {
    kind: "failed",
    err,
    errorKind: "session_gone",
    repairAttempted: false,
  });
  assert.deepEqual(calls, ["attempt"]);
});

test("transient delivery errors propagate untouched for the next-tick retry", async () => {
  const transient = Object.assign(new Error("socket reset"), { code: "ECONNRESET" });

  await assert.rejects(
    deliverResumeRepairingWedgedTurn({
      async attempt() {
        throw transient;
      },
      classifyError() {
        return "wedged_turn";
      },
      async interruptOpenTurn() {
        throw new Error("interrupt must not run for a transient error");
      },
    }),
    (err: unknown) => err === transient,
  );
});

test("a repair whose retry fails again reports the retry error without a third attempt", async () => {
  const calls: string[] = [];
  let attempts = 0;
  const retryErr = new Error("410 session gone");

  const delivery = await deliverResumeRepairingWedgedTurn({
    async attempt() {
      attempts += 1;
      calls.push(`attempt:${attempts}`);
      throw attempts === 1 ? new Error("waiting on responses to events [sevt_1]") : retryErr;
    },
    classifyError(err) {
      return err === retryErr ? "session_gone" : "wedged_turn";
    },
    async interruptOpenTurn() {
      calls.push("interrupt");
    },
  });

  assert.deepEqual(delivery, {
    kind: "failed",
    err: retryErr,
    errorKind: "session_gone",
    repairAttempted: true,
  });
  assert.deepEqual(calls, ["attempt:1", "interrupt", "attempt:2"]);
});
