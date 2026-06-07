import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildResolvedIncidentSlackRoot,
  runResolvedIncidentSideEffects,
} from "./resolution-side-effects.js";

test("runResolvedIncidentSideEffects closes incident PRs through the shared helper and refreshes Slack root", async () => {
  const calls: string[] = [];

  const result = await runResolvedIncidentSideEffects({
    incident: {
      id: "inc-1",
      title: "Checkout API timeout",
      service: "checkout-api",
    },
    projectName: "Acme",
    deps: {
      closeIncidentPullRequests: async (incidentId) => {
        calls.push(`close-prs:${incidentId}`);
        return { closedPullRequestCount: 2, failedPullRequestCount: 0 };
      },
      updateSlackRootMessage: async (input) => {
        calls.push(`slack:${input.incident.id}:${input.text}`);
      },
    },
  });

  assert.deepEqual(result, { closedPullRequestCount: 2, failedPullRequestCount: 0 });
  assert.deepEqual(calls, [
    "close-prs:inc-1",
    "slack:inc-1::white_check_mark: Checkout API timeout - Incident resolved",
  ]);
});

test("runResolvedIncidentSideEffects still refreshes Slack when PR closure reports failures", async () => {
  const calls: string[] = [];
  const result = await runResolvedIncidentSideEffects({
    incident: { id: "inc-1", title: "Checkout API timeout", service: null },
    projectName: "Acme",
    deps: {
      closeIncidentPullRequests: async () => {
        calls.push("close-prs");
        return { closedPullRequestCount: 0, failedPullRequestCount: 1 };
      },
      updateSlackRootMessage: async () => {
        calls.push("slack");
      },
    },
  });

  assert.deepEqual(result, { closedPullRequestCount: 0, failedPullRequestCount: 1 });
  assert.deepEqual(calls, ["close-prs", "slack"]);
});

test("buildResolvedIncidentSlackRoot removes resolve action and keeps feedback action", () => {
  const update = buildResolvedIncidentSlackRoot({
    incident: {
      id: "inc-1",
      title: "Checkout API timeout",
      service: "checkout-api",
    },
    projectName: "Acme",
  });

  assert.equal(update.text, ":white_check_mark: Checkout API timeout - Incident resolved");
  assert.equal(JSON.stringify(update.blocks).includes("resolve_incident:"), false);
  assert.equal(JSON.stringify(update.blocks).includes("give_feedback:inc-1"), true);
});
