import assert from "node:assert/strict";
import { test } from "node:test";
import type { SpendLimitCustomer, SpendLimitDeps } from "@superlog/billing";
import type { JobDeps } from "../jobs.js";
import { createSpendLimitJob } from "./spend-limit.js";

const ENABLED = { AUTUMN_SECRET_KEY: "configured", BILLING_SPEND_LIMITS_ENABLED: "true" };

function customer(usage: number): SpendLimitCustomer {
  return {
    planId: "payg",
    balances: [
      { featureId: "investigations", usage, granted: 50, unlimited: false, nextResetAt: null },
    ],
    spendLimits: [],
  };
}

test("the job only schedules when billing and spend limits are both on", async () => {
  const off = [
    {},
    { AUTUMN_SECRET_KEY: "configured" },
    { BILLING_SPEND_LIMITS_ENABLED: "true" },
    { AUTUMN_SECRET_KEY: "configured", BILLING_SPEND_LIMITS_ENABLED: "false" },
  ];
  for (const env of off) {
    assert.equal(await createSpendLimitJob({ env }).create({} as JobDeps), null);
  }
  assert.ok(await createSpendLimitJob({ env: ENABLED }).create({} as JobDeps));
});

test("each pass reconciles every limit and reports the result", async () => {
  const writes: string[] = [];
  const notified: Array<{ orgId: string; status: string }> = [];
  const billing: SpendLimitDeps = {
    loadCustomer: async (orgId) => customer(orgId === "over" ? 100 : 60),
    writeSpendLimits: async (orgId) => {
      writes.push(orgId);
    },
  };
  const definition = createSpendLimitJob({
    env: ENABLED,
    createBilling: () => billing,
    loadLimits: async () => [
      { orgId: "over", monthlyLimitCents: 5_000 },
      { orgId: "fine", monthlyLimitCents: 5_000 },
    ],
    notify: async ({ orgId, state }) => {
      notified.push({ orgId, status: state.status });
    },
  });

  assert.equal(definition.schedule, "* * * * *");
  const handler = await definition.create({} as JobDeps);
  await handler?.();

  assert.deepEqual(writes, ["over"]);
  assert.deepEqual(notified, [
    { orgId: "over", status: "reached" },
    { orgId: "fine", status: "under" },
  ]);
});

test("one org's billing failure doesn't stop the rest", async () => {
  const notified: string[] = [];
  const definition = createSpendLimitJob({
    env: ENABLED,
    createBilling: () => ({
      loadCustomer: async (orgId) => {
        if (orgId === "broken") throw new Error("autumn 500");
        return customer(60);
      },
      writeSpendLimits: async () => {},
    }),
    loadLimits: async () => [
      { orgId: "broken", monthlyLimitCents: 5_000 },
      { orgId: "fine", monthlyLimitCents: 5_000 },
    ],
    notify: async ({ orgId }) => {
      notified.push(orgId);
    },
  });

  const handler = await definition.create({} as JobDeps);
  await handler?.();

  assert.deepEqual(notified, ["fine"]);
});

test("an org that can't be measured gets no notice", async () => {
  const notified: string[] = [];
  const definition = createSpendLimitJob({
    env: ENABLED,
    createBilling: () => ({
      loadCustomer: async () => null,
      writeSpendLimits: async () => {},
    }),
    loadLimits: async () => [{ orgId: "unknown", monthlyLimitCents: 5_000 }],
    notify: async ({ orgId }) => {
      notified.push(orgId);
    },
  });

  const handler = await definition.create({} as JobDeps);
  await handler?.();

  assert.deepEqual(notified, []);
});
