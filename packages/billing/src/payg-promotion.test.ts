import assert from "node:assert/strict";
import { test } from "node:test";
import { PAYG_PROMOTION_CREDITS, ensurePaygPromotion } from "./payg-promotion.js";

test("an active PAYG customer receives the one-time investigation promotion", async () => {
  const created: Array<{
    customerId: string;
    featureId: string;
    includedGrant: number;
    balanceId: string;
  }> = [];

  const result = await ensurePaygPromotion(
    {
      loadSubscriptions: async () => [{ planId: "payg", status: "active" }],
      createPromotionBalance: async (input) => {
        created.push(input);
        return "created";
      },
    },
    "org-123",
  );

  assert.equal(result, "granted");
  assert.deepEqual(created, [
    {
      customerId: "org-123",
      featureId: "investigations",
      includedGrant: PAYG_PROMOTION_CREDITS,
      balanceId: "payg-welcome-investigations-org-123",
    },
  ]);
});

test("a customer without an active PAYG subscription cannot receive the promotion", async () => {
  let createCalls = 0;
  const result = await ensurePaygPromotion(
    {
      loadSubscriptions: async () => [
        { planId: "free", status: "active" },
        { planId: "payg", status: "scheduled" },
      ],
      createPromotionBalance: async () => {
        createCalls += 1;
        return "created";
      },
    },
    "org-123",
  );

  assert.equal(result, "not_eligible");
  assert.equal(createCalls, 0);
});

test("the deterministic balance makes repeat promotion requests idempotent", async () => {
  const result = await ensurePaygPromotion(
    {
      loadSubscriptions: async () => [{ planId: "payg", status: "active" }],
      createPromotionBalance: async () => "already_exists",
    },
    "org-123",
  );

  assert.equal(result, "already_granted");
});
