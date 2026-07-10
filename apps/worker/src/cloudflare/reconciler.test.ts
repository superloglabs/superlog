import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  type CloudflareReconcileInstallation,
  type CloudflareReconcilerStore,
  type WorkerWiringFn,
  runCloudflareReconcileOnce,
} from "./reconciler.js";

const noopLog = {
  info() {},
  warn() {},
  error() {},
};

function installation(id: string): CloudflareReconcileInstallation {
  return { id, accountId: `acc-${id}`, slugs: { traces: "t", logs: "l" } };
}

// A store whose freshAccessToken is driven by a per-id map: a string token, null
// (no usable grant → skip), or an Error to throw (DB failure → abort).
function makeStore(
  installs: CloudflareReconcileInstallation[],
  tokens: Record<string, string | null | Error>,
): CloudflareReconcilerStore {
  return {
    async listAutoWireInstallations() {
      return installs;
    },
    async freshAccessToken(id) {
      const t = tokens[id];
      if (t instanceof Error) throw t;
      return t ?? null;
    },
  };
}

test("reconcile wires every auto-wire install and tallies workers", async () => {
  const installs = [installation("a"), installation("b")];
  const wiredCalls: string[] = [];
  const reconcile: WorkerWiringFn = async ({ accountId }) => {
    wiredCalls.push(accountId);
    return { scripts: 3, wired: accountId === "acc-a" ? 2 : 1, listOk: true };
  };

  const stats = await runCloudflareReconcileOnce({
    store: makeStore(installs, { a: "tok-a", b: "tok-b" }),
    reconcile,
    log: noopLog,
  });

  assert.deepEqual(wiredCalls.sort(), ["acc-a", "acc-b"]);
  assert.equal(stats.installations, 2);
  assert.equal(stats.reconciled, 2);
  assert.equal(stats.workersWired, 3);
  assert.equal(stats.skipped, 0);
  assert.equal(stats.errors, 0);
});

test("reconcile skips installs with no usable grant, without touching Cloudflare", async () => {
  const installs = [installation("live"), installation("dead")];
  let reconciled = 0;
  const reconcile: WorkerWiringFn = async () => {
    reconciled += 1;
    return { scripts: 1, wired: 1, listOk: true };
  };

  const stats = await runCloudflareReconcileOnce({
    store: makeStore(installs, { live: "tok", dead: null }),
    reconcile,
    log: noopLog,
  });

  assert.equal(reconciled, 1); // only the live install reached the wiring pass
  assert.equal(stats.reconciled, 1);
  assert.equal(stats.skipped, 1);
  assert.equal(stats.errors, 0);
});

test("a wiring failure for one install is isolated, not fatal", async () => {
  const installs = [installation("bad"), installation("good")];
  const reconcile: WorkerWiringFn = async ({ accountId }) => {
    if (accountId === "acc-bad") throw new Error("cf blew up");
    return { scripts: 2, wired: 2, listOk: true };
  };

  const stats = await runCloudflareReconcileOnce({
    store: makeStore(installs, { bad: "tok", good: "tok" }),
    reconcile,
    log: noopLog,
  });

  assert.equal(stats.installations, 2);
  assert.equal(stats.reconciled, 1); // good still ran
  assert.equal(stats.workersWired, 2);
  assert.equal(stats.errors, 1);
});

test("a token/DB failure aborts the whole pass (rethrows)", async () => {
  const installs = [installation("db-error"), installation("never-reached")];
  let reconciled = 0;
  const reconcile: WorkerWiringFn = async () => {
    reconciled += 1;
    return { scripts: 1, wired: 1, listOk: true };
  };

  await assert.rejects(
    runCloudflareReconcileOnce({
      store: makeStore(installs, { "db-error": new Error("pg down"), "never-reached": "tok" }),
      reconcile,
      log: noopLog,
    }),
    /pg down/,
  );
  assert.equal(reconciled, 0); // aborted before wiring anything
});
