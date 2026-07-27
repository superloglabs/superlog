import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcilePaygPromotions } from "./payg-promotion-reconciliation.js";

test("reconciles the one-time grant for every active PAYG customer across pages", async () => {
  const granted: string[] = [];
  const summary = await reconcilePaygPromotions({
    listActivePaygCustomers: async (cursor) =>
      cursor === undefined
        ? { customerIds: ["org-1", "org-2"], nextCursor: "page-2" }
        : { customerIds: ["org-3"], nextCursor: null },
    grantPromotion: async (customerId) => {
      granted.push(customerId);
      return customerId === "org-2" ? "already_granted" : "granted";
    },
  });

  assert.deepEqual(granted, ["org-1", "org-2", "org-3"]);
  assert.deepEqual(summary, {
    examined: 3,
    granted: 2,
    alreadyGranted: 1,
    failed: 0,
  });
});

test("one customer failure does not prevent later PAYG grants", async () => {
  const attempted: string[] = [];
  const summary = await reconcilePaygPromotions({
    listActivePaygCustomers: async () => ({
      customerIds: ["org-fails", "org-succeeds"],
      nextCursor: null,
    }),
    grantPromotion: async (customerId) => {
      attempted.push(customerId);
      if (customerId === "org-fails") throw new Error("provider unavailable");
      return "granted";
    },
  });

  assert.deepEqual(attempted, ["org-fails", "org-succeeds"]);
  assert.deepEqual(summary, {
    examined: 2,
    granted: 1,
    alreadyGranted: 0,
    failed: 1,
  });
});

test("a provider page failure is reported and counted before reconciliation stops", async () => {
  const pageErrors: unknown[] = [];
  const providerError = new Error("provider unavailable");
  const summary = await reconcilePaygPromotions({
    listActivePaygCustomers: async () => {
      throw providerError;
    },
    grantPromotion: async () => "granted",
    onPageError: (error) => pageErrors.push(error),
  });

  assert.deepEqual(pageErrors, [providerError]);
  assert.deepEqual(summary, {
    examined: 0,
    granted: 0,
    alreadyGranted: 0,
    failed: 1,
  });
});
