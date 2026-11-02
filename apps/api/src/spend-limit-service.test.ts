import assert from "node:assert/strict";
import { test } from "node:test";
import type { SpendLimitControl, SpendLimitCustomer } from "@superlog/billing";
import { SpendLimitRejected, createSpendLimitService } from "./spend-limit-service.js";

const ORG = "org-1";

function paygCustomer(overrides: Partial<SpendLimitCustomer> = {}): SpendLimitCustomer {
  return {
    planId: "payg",
    balances: [
      { featureId: "investigations", usage: 80, granted: 50, unlimited: false, nextResetAt: 7 },
    ],
    spendLimits: [],
    ...overrides,
  };
}

function harness(input: { customer?: SpendLimitCustomer | null; limitCents?: number | null } = {}) {
  const stored = { limitCents: input.limitCents ?? null };
  const writes: SpendLimitControl[][] = [];
  const log: string[] = [];
  let failWrites = false;
  const service = createSpendLimitService({
    store: {
      get: async () => stored.limitCents,
      save: async (_orgId, cents) => {
        log.push("save");
        stored.limitCents = cents;
      },
      remove: async () => {
        log.push("remove");
        stored.limitCents = null;
      },
    },
    billing: {
      loadCustomer: async () => (input.customer === undefined ? paygCustomer() : input.customer),
      writeSpendLimits: async (_orgId, limits) => {
        if (failWrites) throw new Error("autumn down");
        log.push("write");
        writes.push(limits);
      },
    },
  });
  return {
    service,
    stored,
    writes,
    log,
    failNextWrites: () => {
      failWrites = true;
    },
  };
}

test("reading reports the plan's minimum and progress, and never writes", async () => {
  const { service, writes } = harness({ limitCents: 4_000 });

  const view = await service.read(ORG);

  assert.deepEqual(view, {
    available: true,
    minimumUsd: 1,
    limitUsd: 40,
    status: "reached",
    billUsd: 45,
    pct: 112,
    resetsAt: 7,
  });
  assert.deepEqual(writes, []);
});

test("reading without a limit offers the control", async () => {
  const { service } = harness();

  assert.deepEqual(await service.read(ORG), {
    available: true,
    minimumUsd: 1,
    limitUsd: null,
    status: "none",
    billUsd: 45,
    pct: null,
    resetsAt: 7,
  });
});

test("a plan that can't carry a limit is reported as unavailable", async () => {
  const { service } = harness({ customer: paygCustomer({ planId: "free" }) });

  assert.deepEqual(await service.read(ORG), {
    available: false,
    minimumUsd: null,
    limitUsd: null,
    status: "none",
    billUsd: null,
    pct: null,
    resetsAt: null,
  });
});

test("an unreadable customer is reported as unavailable", async () => {
  const { service } = harness({ customer: null });

  assert.equal((await service.read(ORG)).available, false);
});

test("setting a limit below the current bill applies the freeze immediately", async () => {
  const { service, stored, writes } = harness();

  const view = await service.set(ORG, 4_000);

  assert.equal(stored.limitCents, 4_000);
  assert.equal(view.status, "reached");
  assert.deepEqual(writes, [[{ featureId: "investigations", enabled: true, overageLimit: 30 }]]);
});

test("raising a reached limit lifts the freeze immediately", async () => {
  const frozen = [{ featureId: "investigations", enabled: true, overageLimit: 30 }];
  const { service, writes } = harness({
    customer: paygCustomer({ spendLimits: frozen }),
    limitCents: 4_000,
  });

  const view = await service.set(ORG, 10_000);

  assert.equal(view.status, "under");
  assert.deepEqual(writes, [[]]);
});

test("an invalid limit is rejected without saving", async () => {
  const { service, stored } = harness({ customer: paygCustomer({ planId: "pack_150" }) });

  await assert.rejects(
    service.set(ORG, 10_000),
    (err) => err instanceof SpendLimitRejected && err.reason === "below_plan_fee",
  );
  assert.equal(stored.limitCents, null);
});

test("an unreadable customer can't take a new limit", async () => {
  const { service, stored } = harness({ customer: null });

  await assert.rejects(
    service.set(ORG, 4_000),
    (err) => err instanceof SpendLimitRejected && err.reason === "unavailable",
  );
  assert.equal(stored.limitCents, null);
});

test("a saved limit survives a failed provider write, for the next pass to apply", async () => {
  const { service, stored, failNextWrites } = harness();
  failNextWrites();

  const view = await service.set(ORG, 4_000);

  assert.equal(stored.limitCents, 4_000);
  assert.equal(view.limitUsd, 40);
});

test("removing a limit clears the intent before lifting the freeze", async () => {
  const frozen = [{ featureId: "investigations", enabled: true, overageLimit: 30 }];
  const { service, stored, log } = harness({
    customer: paygCustomer({ spendLimits: frozen }),
    limitCents: 4_000,
  });

  await service.remove(ORG);

  assert.deepEqual(log, ["remove", "write"]);
  assert.equal(stored.limitCents, null);
});

test("a failed lift still removes the limit, for the next pass to finish", async () => {
  const frozen = [{ featureId: "investigations", enabled: true, overageLimit: 30 }];
  const { service, stored, failNextWrites } = harness({
    customer: paygCustomer({ spendLimits: frozen }),
    limitCents: 4_000,
  });
  failNextWrites();

  await service.remove(ORG);

  assert.equal(stored.limitCents, null);
});
