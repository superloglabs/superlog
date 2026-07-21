import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRunResult } from "@superlog/db";
import {
  type LinearDeliveryDeps,
  deliverLinearTicketWithDeps,
  investigationMarker,
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
  listTeams: unknown[];
  markNeedsReauth: unknown[];
};

function makeDeps(overrides: Partial<LinearDeliveryDeps> = {}): LinearDeliveryDeps & {
  calls: DepCalls;
} {
  const calls: DepCalls = {
    searchIssues: [],
    createIssue: [],
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
  agentRunId: "run-1",
  incidentTitle: "Checkout requests fail under load",
  orgSlug: "acme",
  projectSlug: "shop",
  hasInstall: true,
  defaultTeamId: null,
  prUrls: [],
};

test("a connected Linear integration always enables delivery", () => {
  assert.equal(linearDeliveryAllowed({ hasInstall: false }), false);
  assert.equal(linearDeliveryAllowed({ hasInstall: true }), true);
});

test("creates a ticket with a completed-investigation marker when nothing exists", async () => {
  const deps = makeDeps();
  const ticket = await deliverLinearTicketWithDeps(BASE_ARGS, RESULT, deps);
  assert.deepEqual(ticket, {
    ticketId: "issue-uuid",
    identifier: "ENG-42",
    url: "https://linear.app/eng/issue/ENG-42",
    created: true,
  });
  const created = deps.calls.createIssue[0] as {
    teamId: string;
    description: string;
    title: string;
  };
  assert.equal(created.teamId, "team-1");
  assert.equal(created.title, BASE_ARGS.incidentTitle);
  assert.ok(created.description.includes(investigationMarker("inc-1", "run-1")));
  assert.ok(created.description.includes("## Root cause"));
});

test("uses the configured default team without listing teams", async () => {
  const deps = makeDeps();
  await deliverLinearTicketWithDeps({ ...BASE_ARGS, defaultTeamId: "team-9" }, RESULT, deps);
  assert.equal(deps.calls.listTeams.length, 0);
  assert.equal((deps.calls.createIssue[0] as { teamId: string }).teamId, "team-9");
});

test("reuses the ticket already recorded for the same completed investigation", async () => {
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
});

test("resolves a legacy recorded Linear identifier to the issue UUID", async () => {
  const deps = makeDeps({
    findKnownTicket: async () => ({
      ticketId: "ENG-7",
      identifier: "ENG-7",
      url: "https://linear.app/eng/issue/ENG-7",
    }),
    searchIssues: async (term) => {
      deps.calls.searchIssues.push(term);
      return term === "ENG-7"
        ? [
            {
              id: "unrelated-issue",
              identifier: "OPS-3",
              url: "https://linear.app/ops/issue/OPS-3",
            },
            {
              id: "0b6e7f7e-6f3a-4b8e-9a4e-2d1c3b4a5f6e",
              identifier: "ENG-7",
              url: "https://linear.app/eng/issue/ENG-7",
            },
          ]
        : [];
    },
  });

  const ticket = await deliverLinearTicketWithDeps(BASE_ARGS, RESULT, deps);

  assert.equal(ticket?.ticketId, "0b6e7f7e-6f3a-4b8e-9a4e-2d1c3b4a5f6e");
  assert.deepEqual(deps.calls.searchIssues, ["ENG-7"]);
});

test("recovers a provider-created ticket only when its exact investigation marker is present", async () => {
  const marker = investigationMarker("inc-1", "run-1");
  const deps = makeDeps({
    searchIssues: async () => [
      {
        id: "issue-3",
        identifier: "OPS-3",
        url: "https://linear.app/ops/issue/OPS-3",
        description: `Investigation complete.\n\n${marker}`,
      },
    ],
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

test("creates a ticket without trusting fuzzy provider search results", async () => {
  const searchTerms: string[] = [];
  const deps = makeDeps({
    searchIssues: async (term) => {
      searchTerms.push(term);
      return [
        {
          id: "unrelated-issue",
          identifier: "OPS-3",
          url: "https://linear.app/ops/issue/OPS-3",
          description: "superlog_incident_id=someone-else superlog_agent_run_id=another-run",
        },
      ];
    },
  });
  const ticket = await deliverLinearTicketWithDeps(BASE_ARGS, RESULT, deps);
  assert.deepEqual(ticket, {
    ticketId: "issue-uuid",
    identifier: "ENG-42",
    url: "https://linear.app/eng/issue/ENG-42",
    created: true,
  });
  assert.deepEqual(searchTerms, [investigationMarker("inc-1", "run-1")]);
  assert.equal(deps.calls.createIssue.length, 1);
});

test("returns null and marks reauth on revoked-token errors, never throwing", async () => {
  const deps = makeDeps({
    createIssue: async () => {
      throw new Error("linear issueCreate failed: 401 invalid_grant refresh token revoked");
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

test("ticket description includes every open PR link", () => {
  const desc = ticketDescription(
    {
      incidentId: "inc-1",
      agentRunId: "run-1",
      incidentTitle: "t",
      orgSlug: "acme",
      projectSlug: "shop",
    },
    RESULT,
    ["https://github.com/acme/shop/pull/12", "https://github.com/acme/api/pull/15"],
  );
  assert.ok(desc.includes("Proposed fixes:"));
  assert.ok(desc.includes("- https://github.com/acme/shop/pull/12"));
  assert.ok(desc.includes("- https://github.com/acme/api/pull/15"));
  assert.ok(desc.includes("/app/org/acme/project/shop/incidents/inc-1"));
  assert.ok(desc.includes(investigationMarker("inc-1", "run-1")));
});

test("disconnected Linear skips all provider calls", async () => {
  const deps = makeDeps();
  const ticket = await deliverLinearTicketWithDeps(
    { ...BASE_ARGS, hasInstall: false },
    RESULT,
    deps,
  );

  assert.equal(ticket, null);
  assert.equal(deps.calls.searchIssues.length, 0);
  assert.equal(deps.calls.createIssue.length, 0);
  assert.equal(deps.calls.listTeams.length, 0);
});

test("isRevokedTokenError matches auth failures only", () => {
  assert.equal(isRevokedTokenError(new Error("oauth refresh failed: invalid_grant")), true);
  assert.equal(isRevokedTokenError(new Error("401 Unauthorized")), true);
  assert.equal(isRevokedTokenError(new Error("500 upstream broke")), false);
});
