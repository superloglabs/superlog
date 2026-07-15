import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcileIncidentResolutionFollowUp } from "./resolution-follow-up.js";

test("resolve then reopen then late completion snapshot suppresses resolved follow-ups", async () => {
  const calls: string[] = [];

  const outcome = await reconcileIncidentResolutionFollowUp({
    isCurrentResolution: async () => false,
    closePullRequests: async () => calls.push("close_pull_requests"),
    publish: async () => {
      calls.push("slack:resolved", "linear:resolved");
    },
    reconcileStalePublication: async () => {
      calls.push("reconcile_open");
    },
  });

  assert.equal(outcome, "skipped");
  assert.deepEqual(calls, []);
});

test("reopen after PR reconciliation but before publication suppresses resolved follow-ups", async () => {
  const calls: string[] = [];
  const ownership = [true, false];

  const outcome = await reconcileIncidentResolutionFollowUp({
    isCurrentResolution: async () => ownership.shift() ?? false,
    closePullRequests: async () => calls.push("close_pull_requests"),
    publish: async () => {
      calls.push("slack:resolved", "linear:resolved");
    },
    reconcileStalePublication: async () => {
      calls.push("reconcile_open");
    },
  });

  assert.equal(outcome, "skipped");
  assert.deepEqual(calls, ["close_pull_requests"]);
});

test("reopen during resolved follow-up publication compensates to the durable current state", async () => {
  const calls: string[] = [];
  const ownership = [true, true, false];

  const outcome = await reconcileIncidentResolutionFollowUp({
    isCurrentResolution: async () => ownership.shift() ?? false,
    closePullRequests: async () => calls.push("close_pull_requests"),
    publish: async () => {
      calls.push("slack:resolved", "linear:resolved");
    },
    reconcileStalePublication: async () => {
      calls.push("reconcile_open");
    },
  });

  assert.equal(outcome, "reconciled");
  assert.deepEqual(calls, [
    "close_pull_requests",
    "slack:resolved",
    "linear:resolved",
    "reconcile_open",
  ]);
});
