import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildResolvedIncidentSlackRoot,
  runResolvedIncidentSideEffects,
  shouldRunResolvedIncidentSideEffects,
} from "./resolution-side-effects.js";

test("shouldRunResolvedIncidentSideEffects runs cleanup for stale already-closed resolve requests", () => {
  assert.equal(
    shouldRunResolvedIncidentSideEffects({ requestedStatus: "resolved", incidentExists: true }),
    true,
  );
});

test("shouldRunResolvedIncidentSideEffects skips reopen requests and missing incidents", () => {
  assert.equal(
    shouldRunResolvedIncidentSideEffects({ requestedStatus: "open", incidentExists: true }),
    false,
  );
  assert.equal(
    shouldRunResolvedIncidentSideEffects({ requestedStatus: "resolved", incidentExists: false }),
    false,
  );
});

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

test("runResolvedIncidentSideEffects still refreshes Slack when PR closure throws", async () => {
  const calls: string[] = [];
  const result = await runResolvedIncidentSideEffects({
    incident: { id: "inc-1", title: "Checkout API timeout", service: null },
    projectName: "Acme",
    deps: {
      closeIncidentPullRequests: async () => {
        calls.push("close-prs");
        throw new Error("github unavailable");
      },
      updateSlackRootMessage: async () => {
        calls.push("slack");
      },
    },
  });

  assert.deepEqual(result, { closedPullRequestCount: 0, failedPullRequestCount: 1 });
  assert.deepEqual(calls, ["close-prs", "slack"]);
});

test("runResolvedIncidentSideEffects does not fail when Slack refresh throws", async () => {
  const result = await runResolvedIncidentSideEffects({
    incident: { id: "inc-1", title: "Checkout API timeout", service: null },
    projectName: "Acme",
    deps: {
      closeIncidentPullRequests: async () => ({
        closedPullRequestCount: 1,
        failedPullRequestCount: 0,
      }),
      updateSlackRootMessage: async () => {
        throw new Error("slack unavailable");
      },
    },
  });

  assert.deepEqual(result, { closedPullRequestCount: 1, failedPullRequestCount: 0 });
});

test("buildResolvedIncidentSlackRoot removes resolve action and keeps rating actions", () => {
  const update = buildResolvedIncidentSlackRoot({
    incident: {
      id: "inc-1",
      title: "Checkout API timeout",
      service: "checkout-api",
    },
    projectName: "Acme",
  });

  const json = JSON.stringify(update.blocks);
  assert.equal(update.text, ":white_check_mark: Checkout API timeout - Incident resolved");
  assert.equal(json.includes("resolve_incident:"), false);
  // The incident link now lives on the title, not a standalone button.
  assert.equal(json.includes("open_superlog"), false);
  assert.equal(json.includes("rate_incident:helpful:inc-1"), true);
  assert.equal(json.includes("rate_incident:unhelpful:inc-1"), true);
});
