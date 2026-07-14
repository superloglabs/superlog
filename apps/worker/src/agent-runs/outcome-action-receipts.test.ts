import assert from "node:assert/strict";
import { test } from "node:test";
import type { OutcomeActionExecution } from "../agent-runner-backend.js";
import {
  type OutcomeActionReceiptLock,
  outcomeActionInputHash,
  runOutcomeActionWithReceipt,
} from "./outcome-action-receipts.js";

function memoryReceiptLock(): OutcomeActionReceiptLock {
  let tail = Promise.resolve();
  let stored: Record<string, unknown> | null = null;
  return {
    async exclusive(_args, task) {
      const previous = tail;
      let release = () => {};
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await task({
          async load() {
            return stored;
          },
          async save(detail) {
            stored = detail;
          },
        });
      } finally {
        release();
      }
    },
  };
}

const args = {
  incidentId: "incident-1",
  agentRunId: "run-1",
  toolUseId: "tool-use-1",
  toolName: "propose_pr",
  input: { pullRequests: [{ repoFullName: "acme/api", branchName: "ash/fix-api" }] },
};

test("outcome input hashes are stable across object key order", () => {
  assert.equal(
    outcomeActionInputHash({ b: 2, a: [{ z: true, y: null }] }),
    outcomeActionInputHash({ a: [{ y: null, z: true }], b: 2 }),
  );
  assert.notEqual(outcomeActionInputHash({ a: 1 }), outcomeActionInputHash({ a: 2 }));
});

test("concurrent replay executes once and returns the canonical acknowledgement", async () => {
  const lock = memoryReceiptLock();
  let executions = 0;
  const execute = async (): Promise<OutcomeActionExecution> => {
    executions += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return {
      handled: true,
      ok: true,
      payload: { ok: true, final: true, prUrl: "https://github.com/acme/api/pull/1" },
    };
  };

  const [first, replay] = await Promise.all([
    runOutcomeActionWithReceipt(lock, args, execute),
    runOutcomeActionWithReceipt(lock, args, execute),
  ]);

  assert.equal(executions, 1);
  assert.deepEqual(replay, first);
});

test("a reused tool-use id with different input fails closed", async () => {
  const lock = memoryReceiptLock();
  let executions = 0;
  await runOutcomeActionWithReceipt(lock, args, async () => ({
    handled: true,
    ok: true,
    payload: { ok: true },
  }));

  const mismatch = await runOutcomeActionWithReceipt(
    lock,
    { ...args, input: { pullRequests: [{ repoFullName: "acme/web" }] } },
    async () => {
      executions += 1;
      return { handled: true, ok: true, payload: { ok: true } };
    },
  );

  assert.equal(executions, 0);
  assert.deepEqual(mismatch, {
    handled: true,
    ok: false,
    payload: {
      ok: false,
      errors: ["Outcome action receipt does not match this tool call; refusing to execute it."],
    },
  });
});

test("handled failures are canonical so replay returns the same correction", async () => {
  const lock = memoryReceiptLock();
  let executions = 0;
  const execute = async (): Promise<OutcomeActionExecution> => {
    executions += 1;
    return {
      handled: true,
      ok: false,
      payload: { ok: false, errors: ["Patch no longer applies."] },
    };
  };

  const first = await runOutcomeActionWithReceipt(lock, args, execute);
  const replay = await runOutcomeActionWithReceipt(lock, args, execute);

  assert.equal(executions, 1);
  assert.deepEqual(replay, first);
});

test("malformed receipts fail closed instead of executing", async () => {
  const lock: OutcomeActionReceiptLock = {
    async exclusive(_args, task) {
      return task({
        async load() {
          return { toolName: "propose_pr", inputHash: "not-the-hash", ok: "yes" };
        },
        async save() {},
      });
    },
  };
  let executed = false;

  const result = await runOutcomeActionWithReceipt(lock, args, async () => {
    executed = true;
    return { handled: true, ok: true, payload: { ok: true } };
  });

  assert.equal(executed, false);
  assert.equal(result.handled, true);
  if (!result.handled || result.deferAck) return;
  assert.equal(result.ok, false);
});

test("a receipt lock failure defers acknowledgement without executing", async () => {
  const lock: OutcomeActionReceiptLock = {
    async exclusive() {
      throw new Error("receipt lock unavailable");
    },
  };
  let executed = false;

  const result = await runOutcomeActionWithReceipt(lock, args, async () => {
    executed = true;
    return { handled: true, ok: true, payload: { ok: true } };
  });

  assert.equal(executed, false);
  assert.deepEqual(result, { handled: true, deferAck: true });
});

test("a receipt load failure defers acknowledgement without executing", async () => {
  const lock: OutcomeActionReceiptLock = {
    async exclusive(_args, task) {
      return task({
        async load() {
          throw new Error("receipt read unavailable");
        },
        async save() {},
      });
    },
  };
  let executed = false;

  const result = await runOutcomeActionWithReceipt(lock, args, async () => {
    executed = true;
    return { handled: true, ok: true, payload: { ok: true } };
  });

  assert.equal(executed, false);
  assert.deepEqual(result, { handled: true, deferAck: true });
});

test("a receipt save failure defers acknowledgement after execution", async () => {
  const lock: OutcomeActionReceiptLock = {
    async exclusive(_args, task) {
      return task({
        async load() {
          return null;
        },
        async save() {
          throw new Error("receipt write unavailable");
        },
      });
    },
  };
  let executions = 0;

  const result = await runOutcomeActionWithReceipt(lock, args, async () => {
    executions += 1;
    return { handled: true, ok: true, payload: { ok: true } };
  });

  assert.equal(executions, 1);
  assert.deepEqual(result, { handled: true, deferAck: true });
});
