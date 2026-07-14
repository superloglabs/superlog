import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRunResult } from "@superlog/db";
import {
  type LinearHandoffReconciliationDeps,
  reconcileLinearHandoffWithDeps,
  scheduleLinearHandoffWithDeps,
} from "./linear-handoff.js";

const RESULT: AgentRunResult = { state: "complete", summary: "Investigation complete." };
const TICKET = {
  ticketId: "linear-uuid",
  identifier: "ENG-42",
  url: "https://linear.app/acme/issue/ENG-42",
  created: false,
};

function makeDeps(overrides: Partial<LinearHandoffReconciliationDeps> = {}) {
  const calls = { deliveredPrUrls: [] as string[][], processed: [] as string[][] };
  return {
    calls,
    deps: {
      deliverTicket: async (_result: AgentRunResult, prUrls: string[]) => {
        calls.deliveredPrUrls.push(prUrls);
        return TICKET;
      },
      recordTicket: async () => {},
      linkPullRequests: async () => ({ linkedPullRequests: 2, complete: true }),
      markProcessed: async (ids: string[]) => {
        calls.processed.push(ids);
      },
      ...overrides,
    } satisfies LinearHandoffReconciliationDeps,
  };
}

test("a project without Linear connected does not schedule a handoff", async () => {
  const calls: string[] = [];

  const ticket = await scheduleLinearHandoffWithDeps(
    { hasInstall: false },
    {
      recordPending: async () => {
        calls.push("record_pending");
      },
      dispatch: async () => {
        calls.push("dispatch");
      },
      reconcile: async () => {
        calls.push("reconcile");
        return TICKET;
      },
    },
  );

  assert.equal(ticket, null);
  assert.deepEqual(calls, []);
});

test("a connected Linear project schedules and reconciles its handoff", async () => {
  const calls: string[] = [];

  const ticket = await scheduleLinearHandoffWithDeps(
    { hasInstall: true },
    {
      recordPending: async () => {
        calls.push("record_pending");
      },
      dispatch: async () => {
        calls.push("dispatch");
      },
      reconcile: async () => {
        calls.push("reconcile");
        return TICKET;
      },
    },
  );

  assert.equal(ticket, TICKET);
  assert.deepEqual(calls, ["record_pending", "dispatch", "reconcile"]);
});

test("reconciliation keeps durable work pending when ticket delivery fails", async () => {
  const { deps, calls } = makeDeps({ deliverTicket: async () => null });

  const ticket = await reconcileLinearHandoffWithDeps(
    {
      hasInstall: true,
      pendingEventIds: ["event-1"],
      result: RESULT,
      prUrls: ["https://github.com/acme/api/pull/1"],
    },
    deps,
  );

  assert.equal(ticket, null);
  assert.deepEqual(calls.processed, []);
});

test("reconciliation keeps durable work pending when either link direction fails", async () => {
  const { deps, calls } = makeDeps({
    linkPullRequests: async () => ({ linkedPullRequests: 0, complete: false }),
  });

  await reconcileLinearHandoffWithDeps(
    {
      hasInstall: true,
      pendingEventIds: ["event-1"],
      result: RESULT,
      prUrls: ["https://github.com/acme/api/pull/1"],
    },
    deps,
  );

  assert.deepEqual(calls.processed, []);
});

test("reconciliation links every PR and completes the durable work item", async () => {
  const { deps, calls } = makeDeps();
  const prUrls = ["https://github.com/acme/api/pull/1", "https://github.com/acme/web/pull/2"];

  const ticket = await reconcileLinearHandoffWithDeps(
    {
      hasInstall: true,
      pendingEventIds: ["event-1", "event-2"],
      result: RESULT,
      prUrls,
    },
    deps,
  );

  assert.equal(ticket, TICKET);
  assert.deepEqual(calls.deliveredPrUrls, [prUrls]);
  assert.deepEqual(calls.processed, [["event-1", "event-2"]]);
});

test("disconnected Linear marks the handoff as reconciled without provider calls", async () => {
  let delivered = false;
  const { deps, calls } = makeDeps({
    deliverTicket: async () => {
      delivered = true;
      return TICKET;
    },
  });

  await reconcileLinearHandoffWithDeps(
    {
      hasInstall: false,
      pendingEventIds: ["event-1"],
      result: RESULT,
      prUrls: [],
    },
    deps,
  );

  assert.equal(delivered, false);
  assert.deepEqual(calls.processed, [["event-1"]]);
});
