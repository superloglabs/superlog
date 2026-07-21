import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildIncidentResolutionCompensationSlackRoot,
  buildResolvedIncidentSlackRoot,
  runResolvedIncidentSideEffects,
  shouldRunResolvedIncidentSideEffects,
} from "./resolution-side-effects.js";

const PROJECT_ROUTE = { orgSlug: "acme", projectSlug: "shop" };

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
    projectRoute: PROJECT_ROUTE,
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

test("runResolvedIncidentSideEffects suppresses effects from a stale resolution epoch", async () => {
  const calls: string[] = [];

  const result = await runResolvedIncidentSideEffects({
    incident: {
      id: "inc-1",
      title: "Checkout API timeout",
      service: "checkout-api",
    },
    projectName: "Acme",
    projectRoute: PROJECT_ROUTE,
    resolutionEpoch: {
      isCurrent: async () => false,
      reconcileStalePublication: async () => {
        calls.push("reconcile");
      },
    },
    deps: {
      closeIncidentPullRequests: async () => {
        calls.push("close-prs");
        return { closedPullRequestCount: 1, failedPullRequestCount: 0 };
      },
      updateSlackRootMessage: async () => {
        calls.push("slack");
      },
    },
  });

  assert.deepEqual(result, { closedPullRequestCount: 0, failedPullRequestCount: 0 });
  assert.deepEqual(calls, []);
});

test("runResolvedIncidentSideEffects suppresses resolved publication after the epoch changes during PR closure", async () => {
  const calls: string[] = [];
  const current = [true, false];

  const result = await runResolvedIncidentSideEffects({
    incident: {
      id: "inc-1",
      title: "Checkout API timeout",
      service: "checkout-api",
    },
    projectName: "Acme",
    projectRoute: PROJECT_ROUTE,
    resolutionEpoch: {
      isCurrent: async () => current.shift() ?? false,
      reconcileStalePublication: async () => {
        calls.push("reconcile");
      },
    },
    deps: {
      closeIncidentPullRequests: async () => {
        calls.push("close-prs");
        return { closedPullRequestCount: 1, failedPullRequestCount: 0 };
      },
      updateSlackRootMessage: async () => {
        calls.push("slack");
      },
    },
  });

  assert.deepEqual(result, { closedPullRequestCount: 1, failedPullRequestCount: 0 });
  assert.deepEqual(calls, ["close-prs"]);
});

test("runResolvedIncidentSideEffects compensates when the epoch changes during resolved publication", async () => {
  const calls: string[] = [];
  const current = [true, true, false];

  const result = await runResolvedIncidentSideEffects({
    incident: {
      id: "inc-1",
      title: "Checkout API timeout",
      service: "checkout-api",
    },
    projectName: "Acme",
    projectRoute: PROJECT_ROUTE,
    resolutionEpoch: {
      isCurrent: async () => current.shift() ?? false,
      reconcileStalePublication: async () => {
        calls.push("reconcile");
      },
    },
    deps: {
      closeIncidentPullRequests: async () => {
        calls.push("close-prs");
        return { closedPullRequestCount: 1, failedPullRequestCount: 0 };
      },
      updateSlackRootMessage: async () => {
        calls.push("slack");
      },
    },
  });

  assert.deepEqual(result, { closedPullRequestCount: 1, failedPullRequestCount: 0 });
  assert.deepEqual(calls, ["close-prs", "slack", "reconcile"]);
});

test("runResolvedIncidentSideEffects still refreshes Slack when PR closure reports failures", async () => {
  const calls: string[] = [];
  const result = await runResolvedIncidentSideEffects({
    incident: { id: "inc-1", title: "Checkout API timeout", service: null },
    projectName: "Acme",
    projectRoute: PROJECT_ROUTE,
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
    projectRoute: PROJECT_ROUTE,
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
    projectRoute: PROJECT_ROUTE,
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
    projectRoute: PROJECT_ROUTE,
  });

  const json = JSON.stringify(update.blocks);
  assert.equal(update.text, ":white_check_mark: Checkout API timeout - Incident resolved");
  assert.equal(json.includes("resolve_incident:"), false);
  // The incident link now lives on the title, not a standalone button.
  assert.equal(json.includes("open_superlog"), false);
  assert.equal(json.includes("/app/org/acme/project/shop/incidents/inc-1"), true);
  assert.equal(json.includes("rate_incident:helpful:inc-1"), true);
  assert.equal(json.includes("rate_incident:unhelpful:inc-1"), true);
});

test("buildResolvedIncidentSlackRoot renders the silenced variant for a closed-PR resolution", () => {
  const update = buildResolvedIncidentSlackRoot({
    incident: {
      id: "inc-1",
      title: "Checkout API timeout",
      service: "checkout-api",
    },
    projectName: "Acme",
    projectRoute: PROJECT_ROUTE,
    silencedByClosedPr: { closedByLogin: "octocat" },
  });

  const json = JSON.stringify(update.blocks);
  assert.equal(update.text, ":no_bell: Checkout API timeout - Incident resolved, errors silenced");
  assert.equal(json.includes("PR closed by @octocat"), true);
  assert.equal(json.includes("will not raise incidents anymore"), true);
  assert.equal(json.includes("unsilence_resolve:inc-1"), true);
  assert.equal(json.includes("Do not silence, resolve"), true);
  // Rating buttons stay available alongside the un-silence action.
  assert.equal(json.includes("rate_incident:helpful:inc-1"), true);
});

test("the silenced variant copes with an unknown closer login", () => {
  const update = buildResolvedIncidentSlackRoot({
    incident: {
      id: "inc-1",
      title: "Checkout API timeout",
      service: "checkout-api",
    },
    projectName: "Acme",
    projectRoute: PROJECT_ROUTE,
    silencedByClosedPr: { closedByLogin: null },
  });

  const json = JSON.stringify(update.blocks);
  assert.equal(json.includes("PR closed —"), true);
  assert.equal(json.includes("unsilence_resolve:inc-1"), true);
});

test("resolution publication compensation restores an open incident root", () => {
  const update = buildIncidentResolutionCompensationSlackRoot({
    incident: {
      id: "inc-1",
      title: "Checkout API timeout",
      service: "checkout-api",
      status: "open",
    },
    projectName: "Acme",
    projectRoute: PROJECT_ROUTE,
  });

  const json = JSON.stringify(update.blocks);
  assert.equal(update.text, ":rotating_light: Checkout API timeout - Incident reopened");
  assert.equal(json.includes("resolve_incident:inc-1"), true);
  assert.equal(json.includes("rate_incident:helpful:inc-1"), false);
  assert.equal(json.includes("Incident resolved"), false);
});

test("resolution publication compensation preserves a newer closed epoch", () => {
  const update = buildIncidentResolutionCompensationSlackRoot({
    incident: {
      id: "inc-1",
      title: "Checkout API timeout",
      service: "checkout-api",
      status: "resolved",
    },
    projectName: "Acme",
    projectRoute: PROJECT_ROUTE,
  });

  const json = JSON.stringify(update.blocks);
  assert.equal(update.text, ":white_check_mark: Checkout API timeout - Incident resolved");
  assert.equal(json.includes("resolve_incident:inc-1"), false);
  assert.equal(json.includes("rate_incident:helpful:inc-1"), true);
});
