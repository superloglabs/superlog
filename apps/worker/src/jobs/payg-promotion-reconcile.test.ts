import assert from "node:assert/strict";
import { test } from "node:test";
import type { JobDeps } from "../jobs.js";
import { createPaygPromotionReconcileJob } from "./payg-promotion-reconcile.js";

test("the scheduled reconciliation grants every active PAYG customer exactly once", async () => {
  const created: string[] = [];
  const outcomes: Array<[string, number]> = [];
  const definition = createPaygPromotionReconcileJob({
    env: { AUTUMN_SECRET_KEY: "configured" },
    recordOutcome: (outcome, count) => outcomes.push([outcome, count]),
    createProvider: () => ({
      listActivePaygCustomers: async () => ({
        customerIds: ["org-1", "org-2"],
        nextCursor: null,
      }),
      grantPromotion: async (customerId) => {
        created.push(customerId);
        return customerId === "org-2" ? "already_granted" : "granted";
      },
    }),
  });

  assert.equal(definition.schedule, "* * * * *");
  assert.equal(definition.policy, "exclusive");
  const handler = await definition.create({} as JobDeps);
  assert.ok(handler);
  await handler();
  assert.deepEqual(created, ["org-1", "org-2"]);
  assert.deepEqual(outcomes, [
    ["granted", 1],
    ["already_granted", 1],
    ["failed", 0],
  ]);
});

test("a missing billing secret logs why reconciliation is disabled", async () => {
  const messages: string[] = [];
  const definition = createPaygPromotionReconcileJob({
    env: {},
    logger: {
      info: (_context, message) => messages.push(message),
    },
  });

  assert.equal(await definition.create({} as JobDeps), null);
  assert.deepEqual(messages, [
    "PAYG promotion reconciliation skipped: AUTUMN_SECRET_KEY is not configured",
  ]);
});
