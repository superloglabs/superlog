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

test("the job only schedules when billing is configured", async () => {
  const unbilled = [{}, { BILLING_SPEND_LIMITS_ENABLED: "true" }];
  for (const env of unbilled) {
    assert.equal(await createSpendLimitJob({ env }).create({} as JobDeps), null);
  }
  assert.ok(await createSpendLimitJob({ env: ENABLED }).create({} as JobDeps));
  assert.ok(
    await createSpendLimitJob({ env: { AUTUMN_SECRET_KEY: "configured" } }).create({} as JobDeps),
  );
});

test("with the feature off, existing freezes are lifted and limits are kept", async () => {
  const writes: Array<[string, unknown[]]> = [];
  const notified: string[] = [];
  const forgotten: string[] = [];
  const definition = createSpendLimitJob({
    env: { AUTUMN_SECRET_KEY: "configured", BILLING_SPEND_LIMITS_ENABLED: "false" },
    createBilling: () => ({
      loadCustomer: async () => ({
        ...customer(100),
        spendLimits: [{ featureId: "investigations", enabled: true, overageLimit: 50 }],
      }),
      writeSpendLimits: async (orgId, limits) => {
        writes.push([orgId, limits]);
      },
    }),
    loadLimits: async () => [{ orgId: "over", monthlyLimitCents: 5_000 }],
    forgetRemoved: async (_db, orgId) => {
      forgotten.push(orgId);
    },
    notify: async ({ orgId }) => {
      notified.push(orgId);
    },
  });

  const handler = await definition.create({} as JobDeps);
  await handler?.();

  assert.deepEqual(writes, [["over", []]]);
  assert.deepEqual(notified, []);
  assert.deepEqual(forgotten, []);
});

test("a removed limit is lifted before its row is forgotten", async () => {
  const log: string[] = [];
  const definition = createSpendLimitJob({
    env: ENABLED,
    createBilling: () => ({
      loadCustomer: async () => ({
        ...customer(100),
        spendLimits: [{ featureId: "investigations", enabled: true, overageLimit: 50 }],
      }),
      writeSpendLimits: async () => {
        log.push("lift");
      },
    }),
    loadLimits: async () => [{ orgId: "removed", monthlyLimitCents: null }],
    forgetRemoved: async () => {
      log.push("forget");
    },
    notify: async () => {
      log.push("notify");
    },
  });

  const handler = await definition.create({} as JobDeps);
  await handler?.();

  assert.deepEqual(log, ["lift", "forget"]);
});

test("a failed lift keeps the row for the next pass", async () => {
  const forgotten: string[] = [];
  const definition = createSpendLimitJob({
    env: ENABLED,
    createBilling: () => ({
      loadCustomer: async () => ({
        ...customer(100),
        spendLimits: [{ featureId: "investigations", enabled: true, overageLimit: 50 }],
      }),
      writeSpendLimits: async () => {
        throw new Error("autumn 500");
      },
    }),
    loadLimits: async () => [{ orgId: "removed", monthlyLimitCents: null }],
    forgetRemoved: async (_db, orgId) => {
      forgotten.push(orgId);
    },
  });

  const handler = await definition.create({} as JobDeps);
  await handler?.();

  assert.deepEqual(forgotten, []);
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
