import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AiSpendGuard,
  aiSpendGuard,
  resetAiSpendGuard,
  setAiSpendGuard,
} from "./ai-spend-guard.js";

test.afterEach(() => {
  resetAiSpendGuard();
});

test("allows all runs by default (no-op guard)", async () => {
  assert.equal(await aiSpendGuard.canStartAgentRun("some-org"), true);
});

test("delegates to an installed guard", async () => {
  const checked: string[] = [];
  const guard: AiSpendGuard = {
    canStartAgentRun: async (orgId) => {
      checked.push(orgId);
      return false;
    },
  };
  setAiSpendGuard(guard);
  assert.equal(await aiSpendGuard.canStartAgentRun("over-limit-org"), false);
  assert.deepEqual(checked, ["over-limit-org"]);
});

test("after reset, reverts to allow-all regardless of previous installation", async () => {
  setAiSpendGuard({ canStartAgentRun: async () => false });
  resetAiSpendGuard();
  assert.equal(await aiSpendGuard.canStartAgentRun("org"), true);
});

test("proxy reflects replacement guard installed after first call", async () => {
  assert.equal(await aiSpendGuard.canStartAgentRun("org"), true);
  setAiSpendGuard({ canStartAgentRun: async () => false });
  assert.equal(await aiSpendGuard.canStartAgentRun("org"), false);
});
