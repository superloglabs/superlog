import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type SpendLimitBalance,
  type SpendLimitControl,
  type SpendLimitCustomer,
  createAutumnSpendLimitDeps,
  estimateBillUsd,
  minimumSpendLimitUsd,
  reconcileSpendLimit,
  resolveSpendLimitPlan,
  spendLimitNoticeSteps,
  spendLimitPeriodKey,
  validateSpendLimit,
} from "./spend-limit.js";

function balance(featureId: string, usage: number, granted: number): SpendLimitBalance {
  return { featureId, usage, granted, unlimited: false, nextResetAt: null };
}

function investigationsWithUnusedPromotion(usage: number): SpendLimitBalance {
  return {
    ...balance("investigations", usage, 150),
    breakdown: [
      { usage, includedGrant: 50, prepaidGrant: 0 },
      { usage: 0, includedGrant: 100, prepaidGrant: 0 },
    ],
  };
}

function customer(input: {
  planId: string | null;
  balances: SpendLimitBalance[];
  spendLimits?: SpendLimitControl[];
}): SpendLimitCustomer {
  return { spendLimits: [], ...input };
}

function harness(loaded: SpendLimitCustomer | null) {
  const writes: SpendLimitControl[][] = [];
  return {
    writes,
    deps: {
      loadCustomer: async () => loaded,
      writeSpendLimits: async (_orgId: string, limits: SpendLimitControl[]) => {
        writes.push(limits);
      },
    },
  };
}

test("the estimated bill is the plan fee plus usage beyond each included allowance", () => {
  const bill = estimateBillUsd("pack_150", [
    balance("spans", 3_000_000, 1_000_000), // 2M over @ $0.50/M = $1.00
    balance("logs", 1_000_000, 5_000_000), // inside the allowance
    balance("metric_points", 20_000_000, 10_000_000), // 10M over @ $0.15/M = $1.50
    balance("investigations", 130, 120), // 10 over @ $1.25 = $12.50
  ]);

  assert.equal(bill, 165);
});

test("telemetry bills in whole million-unit blocks, rounded up like the invoice", () => {
  // Autumn previewed 2,000,002 spans over the allowance as a $1.50 line.
  assert.equal(estimateBillUsd("payg", [balance("spans", 3_000_002, 1_000_000)]), 1.5);
  assert.equal(estimateBillUsd("payg", [balance("spans", 3_000_000, 1_000_000)]), 1);
  assert.equal(estimateBillUsd("payg", [balance("metric_points", 10_000_001, 10_000_000)]), 0.15);
});

test("a later grant doesn't hide overage already billed on the plan's balance", () => {
  // Real shape: Autumn invoices the 70 over the plan's 50 even though a 100-credit
  // promotion sits unused, and the top-level usage and granted hide that overage.
  assert.equal(estimateBillUsd("payg", [investigationsWithUnusedPromotion(120)]), 105);
});

test("overage counts unused grants only when usage drew them down", () => {
  assert.equal(estimateBillUsd("payg", [investigationsWithUnusedPromotion(40)]), 0);
  assert.equal(
    estimateBillUsd("payg", [
      {
        ...balance("investigations", 160, 150),
        breakdown: [
          { usage: 50, includedGrant: 50, prepaidGrant: 0 },
          { usage: 110, includedGrant: 100, prepaidGrant: 0 },
        ],
      },
    ]),
    15,
  );
});

test("unlimited features do not contribute to the bill", () => {
  const bill = estimateBillUsd("payg", [
    { featureId: "spans", usage: 9_000_000, granted: 0, unlimited: true, nextResetAt: null },
  ]);

  assert.equal(bill, 0);
});

test("a spend limit can only be set on a plan we can price, above its fixed fee", () => {
  assert.deepEqual(validateSpendLimit("payg", 5_000), { ok: true });
  assert.deepEqual(validateSpendLimit("pack_150", 15_100), { ok: true });
  assert.deepEqual(validateSpendLimit("pack_150", 15_000), { ok: false, reason: "below_plan_fee" });
  assert.deepEqual(validateSpendLimit("free", 5_000), { ok: false, reason: "unsupported_plan" });
  assert.deepEqual(validateSpendLimit("grandfathered", 5_000), {
    ok: false,
    reason: "unsupported_plan",
  });
  assert.deepEqual(validateSpendLimit("payg", 0), { ok: false, reason: "invalid_amount" });
  assert.deepEqual(validateSpendLimit("payg", 12.5), { ok: false, reason: "invalid_amount" });
  assert.deepEqual(validateSpendLimit("payg", 2_147_483_648), {
    ok: false,
    reason: "invalid_amount",
  });
});

test("the smallest accepted limit clears the plan fee, or is a dollar on usage-only plans", () => {
  assert.equal(minimumSpendLimitUsd("payg"), 1);
  assert.equal(minimumSpendLimitUsd("pack_300"), 301);
  assert.equal(minimumSpendLimitUsd("free"), null);
  assert.equal(minimumSpendLimitUsd(null), null);
});

test("the active paid plan wins over a parallel Free subscription and scheduled plans", () => {
  assert.equal(
    resolveSpendLimitPlan([
      { planId: "free", status: "active" },
      { planId: "pack_150", status: "active" },
      { planId: "pack_300", status: "scheduled" },
    ]),
    "pack_150",
  );
  assert.equal(resolveSpendLimitPlan([{ planId: "free", status: "active" }]), "free");
  assert.equal(resolveSpendLimitPlan([]), null);
});

test("reaching the limit freezes each feature at its current billable overage", async () => {
  const { deps, writes } = harness(
    customer({
      planId: "payg",
      balances: [
        balance("spans", 3_000_000, 1_000_000), // over its allowance
        balance("logs", 1_000_000, 5_000_000), // allowance left: stays usable
        balance("investigations", 80, 50), // 30 over @ $1.50 = $45
      ],
    }),
  );

  const state = await reconcileSpendLimit(deps, { orgId: "org", limitCents: 4_000 });

  assert.equal(state.status, "reached");
  assert.deepEqual(writes, [
    [
      { featureId: "spans", enabled: true, overageLimit: 2_000_000 },
      { featureId: "logs", enabled: true, overageLimit: 0 },
      { featureId: "investigations", enabled: true, overageLimit: 30 },
    ],
  ]);
});

test("an org under its limit reports progress without writing", async () => {
  const { deps, writes } = harness(
    customer({ planId: "payg", balances: [balance("investigations", 60, 50)] }),
  );

  const state = await reconcileSpendLimit(deps, { orgId: "org", limitCents: 3_000 });

  assert.deepEqual(state, {
    status: "under",
    billUsd: 15,
    limitUsd: 30,
    pct: 50,
    resetsAt: null,
  });
  assert.deepEqual(writes, []);
});

test("a later grant keeps a reached org frozen at its real overage", async () => {
  const { deps, writes } = harness(
    customer({ planId: "payg", balances: [investigationsWithUnusedPromotion(120)] }),
  );

  const state = await reconcileSpendLimit(deps, { orgId: "org", limitCents: 10_000 });

  assert.equal(state.status, "reached");
  assert.deepEqual(writes, [[{ featureId: "investigations", enabled: true, overageLimit: 70 }]]);
});

test("a reached org that is already frozen is not rewritten", async () => {
  const { deps, writes } = harness(
    customer({
      planId: "payg",
      balances: [balance("investigations", 80, 50)],
      spendLimits: [{ featureId: "investigations", enabled: true, overageLimit: 30 }],
    }),
  );

  const state = await reconcileSpendLimit(deps, { orgId: "org", limitCents: 4_000 });

  assert.equal(state.status, "reached");
  assert.deepEqual(writes, []);
});

test("usage that lands after a freeze does not raise the freeze", async () => {
  const { deps, writes } = harness(
    customer({
      planId: "payg",
      balances: [balance("investigations", 90, 50)],
      spendLimits: [{ featureId: "investigations", enabled: true, overageLimit: 30 }],
    }),
  );

  await reconcileSpendLimit(deps, { orgId: "org", limitCents: 4_000 });

  assert.deepEqual(writes, []);
});

test("raising the limit above the bill lifts the freeze", async () => {
  const { deps, writes } = harness(
    customer({
      planId: "payg",
      balances: [balance("investigations", 80, 50)],
      spendLimits: [{ featureId: "investigations", enabled: true, overageLimit: 30 }],
    }),
  );

  const state = await reconcileSpendLimit(deps, { orgId: "org", limitCents: 10_000 });

  assert.equal(state.status, "under");
  assert.deepEqual(writes, [[]]);
});

test("a new billing cycle lifts the freeze once usage has reset", async () => {
  const { deps, writes } = harness(
    customer({
      planId: "payg",
      balances: [balance("investigations", 0, 50)],
      spendLimits: [{ featureId: "investigations", enabled: true, overageLimit: 30 }],
    }),
  );

  await reconcileSpendLimit(deps, { orgId: "org", limitCents: 4_000 });

  assert.deepEqual(writes, [[]]);
});

test("a limit at the fee of a newly upgraded plan drops frozen overage to zero", async () => {
  // Upgrading can leave a limit at or below the new fee. The fee alone then
  // reaches it, so the org stays "reached" across the cycle boundary, and last
  // cycle's overage must not become this cycle's allowance.
  const { deps, writes } = harness(
    customer({
      planId: "pack_150",
      balances: [balance("investigations", 0, 120)],
      spendLimits: [{ featureId: "investigations", enabled: true, overageLimit: 30 }],
    }),
  );

  const state = await reconcileSpendLimit(deps, { orgId: "org", limitCents: 15_000 });

  assert.equal(state.status, "reached");
  assert.deepEqual(writes, [[{ featureId: "investigations", enabled: true, overageLimit: 0 }]]);
});

test("removing the limit lifts an existing freeze", async () => {
  const { deps, writes } = harness(
    customer({
      planId: "payg",
      balances: [balance("investigations", 80, 50)],
      spendLimits: [{ featureId: "investigations", enabled: true, overageLimit: 30 }],
    }),
  );

  const state = await reconcileSpendLimit(deps, { orgId: "org", limitCents: null });

  assert.equal(state.status, "inactive");
  assert.deepEqual(writes, [[]]);
});

test("moving to a plan we cannot price leaves no freeze behind", async () => {
  const { deps, writes } = harness(
    customer({
      planId: "free",
      balances: [balance("spans", 900_000, 1_000_000)],
      spendLimits: [{ featureId: "spans", enabled: true, overageLimit: 0 }],
    }),
  );

  const state = await reconcileSpendLimit(deps, { orgId: "org", limitCents: 4_000 });

  assert.equal(state.status, "inactive");
  assert.deepEqual(writes, [[]]);
});

test("an unreadable customer changes nothing", async () => {
  const { deps, writes } = harness(null);

  const state = await reconcileSpendLimit(deps, { orgId: "org", limitCents: 4_000 });

  assert.equal(state.status, "unavailable");
  assert.deepEqual(writes, []);
});

test("the next reset is the earliest across features", async () => {
  const { deps } = harness(
    customer({
      planId: "payg",
      balances: [
        { ...balance("spans", 0, 1), nextResetAt: 2_000 },
        { ...balance("logs", 0, 1), nextResetAt: 1_000 },
      ],
    }),
  );

  const state = await reconcileSpendLimit(deps, { orgId: "org", limitCents: 4_000 });

  assert.equal(state.status === "under" ? state.resetsAt : "wrong status", 1_000);
});

test("notices are claimed per cycle and per limit, so a raised limit warns again", () => {
  const resetsAt = Date.UTC(2026, 11, 1);
  const now = new Date(Date.UTC(2026, 10, 15));

  assert.equal(spendLimitPeriodKey(resetsAt, 15_000, now), "spend:2026-12-01:15000");
  assert.equal(spendLimitPeriodKey(null, 15_000, now), "spend:2026-11:15000");
});

test("notice steps fire at 80% and at the limit", () => {
  assert.deepEqual(spendLimitNoticeSteps({ status: "under", pct: 79 }), []);
  assert.deepEqual(spendLimitNoticeSteps({ status: "under", pct: 80 }), [80]);
  assert.deepEqual(spendLimitNoticeSteps({ status: "reached", pct: 100 }), [80, 100]);
});

test("the Autumn adapter maps a customer and treats a missing one as unreadable", async () => {
  const deps = createAutumnSpendLimitDeps({
    customers: {
      get: async ({ customerId }) => {
        if (customerId === "missing") throw Object.assign(new Error("nope"), { statusCode: 404 });
        return {
          subscriptions: [{ planId: "payg", status: "active" }],
          balances: {
            spans: {
              featureId: "spans",
              usage: 5,
              granted: 1,
              unlimited: false,
              nextResetAt: 9,
              breakdown: [{ usage: 5, includedGrant: 1, prepaidGrant: 0, remaining: 0 }],
            },
          },
          billingControls: {
            spendLimits: [{ featureId: "spans", enabled: true, overageLimit: 4 }],
          },
        };
      },
      update: async () => ({}),
    },
  });

  assert.deepEqual(await deps.loadCustomer("org"), {
    planId: "payg",
    balances: [
      {
        featureId: "spans",
        usage: 5,
        granted: 1,
        unlimited: false,
        nextResetAt: 9,
        breakdown: [{ usage: 5, includedGrant: 1, prepaidGrant: 0 }],
      },
    ],
    spendLimits: [{ featureId: "spans", enabled: true, overageLimit: 4 }],
  });
  assert.equal(await deps.loadCustomer("missing"), null);
});

test("the Autumn adapter surfaces errors other than a missing customer", async () => {
  const deps = createAutumnSpendLimitDeps({
    customers: {
      get: async () => {
        throw Object.assign(new Error("boom"), { statusCode: 500 });
      },
      update: async () => ({}),
    },
  });

  await assert.rejects(deps.loadCustomer("org"), /boom/);
});

test("the Autumn adapter writes only the spend limits", async () => {
  const updates: unknown[] = [];
  const deps = createAutumnSpendLimitDeps({
    customers: {
      get: async () => ({ subscriptions: [], balances: {} }),
      update: async (request) => {
        updates.push(request);
        return {};
      },
    },
  });

  await deps.writeSpendLimits("org", []);

  assert.deepEqual(updates, [{ customerId: "org", billingControls: { spendLimits: [] } }]);
});
