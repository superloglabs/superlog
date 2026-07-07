import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRunResult } from "@superlog/db";
import {
  type LinearDeliveryDeps,
  deliverLinearTicketWithDeps,
  incidentMarker,
  isRevokedTokenError,
  linearDeliveryAllowed,
  ticketDescription,
} from "./linear-delivery.js";

const RESULT: AgentRunResult = {
  state: "complete",
  summary: "Checkout requests fail under load.",
  rootCause: { text: "**a.ts:1**\n```ts\nx\n```", confidence: 8 },
  estimatedImpact: { text: "All carts >10 items fail.", confidence: 7 },
  severity: "SEV-2",
};

type DepCalls = {
  searchIssues: unknown[];
  createIssue: unknown[];
  createComment: unknown[];
  listTeams: unknown[];
  markNeedsReauth: unknown[];
};

function makeDeps(overrides: Partial<LinearDeliveryDeps> = {}): LinearDeliveryDeps & {
  calls: DepCalls;
} {
  const calls: DepCalls = {
    searchIssues: [],
    createIssue: [],
    createComment: [],
    listTeams: [],
    markNeedsReauth: [],
  };
  return {
    calls,
    findKnownTicket: async () => null,
    searchIssues: async (term) => {
      calls.searchIssues.push(term);
      return [];
    },
    createIssue: async (args) => {
      calls.createIssue.push(args);
      return { id: "issue-uuid", identifier: "ENG-42", url: "https://linear.app/eng/issue/ENG-42" };
    },
    createComment: async (args) => {
      calls.createComment.push(args);
    },
    listTeams: async () => {
      calls.listTeams.push(null);
      return [{ id: "team-1", key: "ENG", name: "Engineering" }];
    },
    markNeedsReauth: async (reason) => {
      calls.markNeedsReauth.push(reason);
    },
    log: () => {},
    ...overrides,
  };
}

const BASE_ARGS = {
  incidentId: "inc-1",
  incidentTitle: "Checkout requests fail under load",
  policy: "always" as const,
  hasInstall: true,
  defaultTeamId: null,
  prUrl: null,
};

test("policy matrix gates delivery", () => {
  assert.equal(linearDeliveryAllowed({ hasInstall: false, policy: "always", prUrl: null }), false);
  assert.equal(linearDeliveryAllowed({ hasInstall: true, policy: "never", prUrl: "x" }), false);
  assert.equal(
    linearDeliveryAllowed({ hasInstall: true, policy: "on_ready_to_pr", prUrl: null }),
    false,
  );
  assert.equal(
    linearDeliveryAllowed({ hasInstall: true, policy: "on_ready_to_pr", prUrl: "x" }),
    true,
  );
  assert.equal(linearDeliveryAllowed({ hasInstall: true, policy: "always", prUrl: null }), true);
});

test("creates a ticket with the incident marker when nothing exists", async () => {
  const deps = makeDeps();
  const ticket = await deliverLinearTicketWithDeps(BASE_ARGS, RESULT, deps);
  assert.deepEqual(ticket, {
    ticketId: "issue-uuid",
    identifier: "ENG-42",
    url: "https://linear.app/eng/issue/ENG-42",
    created: true,
  });
  const created = deps.calls.createIssue[0] as { teamId: string; description: string; title: string };
  assert.equal(created.teamId, "team-1");
  assert.equal(created.title, BASE_ARGS.incidentTitle);
  assert.ok(created.description.includes(incidentMarker("inc-1")));
  assert.ok(created.description.includes("## Root cause"));
});

test("uses the configured default team without listing teams", async () => {
  const deps = makeDeps();
  await deliverLinearTicketWithDeps({ ...BASE_ARGS, defaultTeamId: "team-9" }, RESULT, deps);
  assert.equal(deps.calls.listTeams.length, 0);
  assert.equal((deps.calls.createIssue[0] as { teamId: string }).teamId, "team-9");
});

test("comments directly on a known UUID ticket without searching", async () => {
  const deps = makeDeps({
    findKnownTicket: async () => ({
      ticketId: "0b6e7f7e-6f3a-4b8e-9a4e-2d1c3b4a5f6e",
      identifier: "ENG-7",
      url: "https://linear.app/eng/issue/ENG-7",
    }),
  });
  const ticket = await deliverLinearTicketWithDeps(BASE_ARGS, RESULT, deps);
  assert.deepEqual(ticket, {
    ticketId: "0b6e7f7e-6f3a-4b8e-9a4e-2d1c3b4a5f6e",
    identifier: "ENG-7",
    url: "https://linear.app/eng/issue/ENG-7",
    created: false,
  });
  assert.equal(deps.calls.searchIssues.length, 0);
  assert.equal(deps.calls.createIssue.length, 0);
  assert.equal(deps.calls.createComment.length, 1);
});

test("resolves a legacy identifier-keyed known ticket via search", async () => {
  const deps = makeDeps({
    findKnownTicket: async () => ({
      ticketId: "ENG-7",
      identifier: null,
      url: "https://linear.app/eng/issue/ENG-7",
    }),
    searchIssues: async () => [
      { id: "issue-7", identifier: "ENG-7", url: "https://linear.app/eng/issue/ENG-7" },
    ],
  });
  const ticket = await deliverLinearTicketWithDeps(BASE_ARGS, RESULT, deps);
  assert.deepEqual(ticket, {
    ticketId: "issue-7",
    identifier: "ENG-7",
    url: "https://linear.app/eng/issue/ENG-7",
    created: false,
  });
  assert.equal(deps.calls.createIssue.length, 0);
  assert.equal(deps.calls.createComment.length, 1);
});

test("dedupes against a marker-matching ticket found via search", async () => {
  const deps = makeDeps({
    searchIssues: async (term) =>
      term === incidentMarker("inc-1")
        ? [{ id: "issue-3", identifier: "OPS-3", url: "https://linear.app/ops/issue/OPS-3" }]
        : [],
  });
  const ticket = await deliverLinearTicketWithDeps(BASE_ARGS, RESULT, deps);
  assert.deepEqual(ticket, {
    ticketId: "issue-3",
    identifier: "OPS-3",
    url: "https://linear.app/ops/issue/OPS-3",
    created: false,
  });
  assert.equal(deps.calls.createIssue.length, 0);
});

test("returns null and marks reauth on revoked-token errors, never throwing", async () => {
  const deps = makeDeps({
    searchIssues: async () => {
      throw new Error("linear searchIssues query failed: 401 invalid_grant refresh token revoked");
    },
  });
  const ticket = await deliverLinearTicketWithDeps(BASE_ARGS, RESULT, deps);
  assert.equal(ticket, null);
  assert.equal(deps.calls.markNeedsReauth.length, 1);
});

test("returns null on non-auth failures without marking reauth", async () => {
  const deps = makeDeps({
    createIssue: async () => {
      throw new Error("linear issueCreate failed: 500 upstream broke");
    },
  });
  const ticket = await deliverLinearTicketWithDeps(BASE_ARGS, RESULT, deps);
  assert.equal(ticket, null);
  assert.equal(deps.calls.markNeedsReauth.length, 0);
});

test("skips delivery when the workspace has no teams", async () => {
  const deps = makeDeps({ listTeams: async () => [] });
  const ticket = await deliverLinearTicketWithDeps(BASE_ARGS, RESULT, deps);
  assert.equal(ticket, null);
  assert.equal(deps.calls.createIssue.length, 0);
});

test("ticket description includes PR link and recommended action when present", () => {
  const desc = ticketDescription(
    { incidentId: "inc-1", incidentTitle: "t" },
    { ...RESULT, recommendedAction: "Raise the provider quota." },
    "https://github.com/acme/shop/pull/12",
  );
  assert.ok(desc.includes("Proposed fix: https://github.com/acme/shop/pull/12"));
  assert.ok(desc.includes("## Recommended action"));
  assert.ok(desc.includes(incidentMarker("inc-1")));
});

test("isRevokedTokenError matches auth failures only", () => {
  assert.equal(isRevokedTokenError(new Error("oauth refresh failed: invalid_grant")), true);
  assert.equal(isRevokedTokenError(new Error("401 Unauthorized")), true);
  assert.equal(isRevokedTokenError(new Error("500 upstream broke")), false);
});
