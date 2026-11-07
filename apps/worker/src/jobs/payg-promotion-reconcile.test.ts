import assert from "node:assert/strict";
import { test } from "node:test";
import { AutumnError } from "autumn-js";
import type { JobDeps } from "../jobs.js";
import {
  createPaygPromotionReconcileJob,
  isExistingPromotionBalance,
  paygPromotionPageSize,
} from "./payg-promotion-reconcile.js";

// Construct a minimal AutumnError with the given status code and body text.
// AutumnDefaultError (the concrete subclass thrown by the SDK) extends AutumnError, so
// instanceof AutumnError is satisfied by both.
function makeAutumnError(statusCode: number, body: string): AutumnError {
  const err = Object.create(AutumnError.prototype) as AutumnError;
  Object.assign(err, { statusCode, body, message: `Status ${statusCode}`, name: "AutumnError" });
  return err;
}

const BALANCE_ID = "payg-welcome-investigations-af55ef4f-7e38-4332-8602-1c61e160117a";

test("isExistingPromotionBalance returns true for Autumn 409 'is already in use' body", () => {
  const body = JSON.stringify({
    message: `balance_id '${BALANCE_ID}' is already in use for this customer`,
    code: "invalid_request",
    env: "live",
  });
  assert.ok(isExistingPromotionBalance(makeAutumnError(409, body), BALANCE_ID));
});

test("isExistingPromotionBalance returns true for legacy balance_already_exists body", () => {
  assert.ok(isExistingPromotionBalance(makeAutumnError(409, "balance_already_exists"), BALANCE_ID));
});

test("isExistingPromotionBalance returns false for a non-409 AutumnError", () => {
  assert.equal(isExistingPromotionBalance(makeAutumnError(422, "is already in use"), BALANCE_ID), false);
});

test("isExistingPromotionBalance returns false for a plain Error", () => {
  assert.equal(isExistingPromotionBalance(new Error("is already in use"), BALANCE_ID), false);
});

test("customer pages stay within the provider limit independently of the run budget", () => {
  assert.equal(paygPromotionPageSize(5_000), 1_000);
  assert.equal(paygPromotionPageSize(700), 700);
});

test("the scheduled reconciliation grants every active PAYG customer exactly once", async () => {
  const created: string[] = [];
  const examined: number[] = [];
  const outcomes: Array<[string, number]> = [];
  const messages: string[] = [];
  let cursor: string | undefined;
  const definition = createPaygPromotionReconcileJob({
    env: { AUTUMN_SECRET_KEY: "configured" },
    recordExamined: (count) => examined.push(count),
    recordOutcome: (outcome, count) => outcomes.push([outcome, count]),
    logger: {
      info: (_context, message) => messages.push(message),
    },
    cursorStore: {
      load: async () => cursor,
      save: async (nextCursor) => {
        cursor = nextCursor ?? undefined;
      },
    },
    createProvider: () => ({
      listActivePaygCustomers: async () => ({
        customerIds: ["org-1", "org-2"],
        scanned: 2,
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
  assert.equal(definition.expireInSeconds, 3_600);
  const handler = await definition.create({} as JobDeps);
  assert.ok(handler);
  await handler();
  assert.deepEqual(created, ["org-1", "org-2"]);
  assert.deepEqual(examined, [2]);
  assert.deepEqual(outcomes, [
    ["granted", 1],
    ["already_granted", 1],
  ]);
  assert.deepEqual(messages, [
    "PAYG promotion reconciliation started",
    "PAYG promotions reconciled",
  ]);
});

test("a missing billing secret logs why reconciliation is disabled", async () => {
  const messages: string[] = [];
  const outcomes: Array<[string, number]> = [];
  const definition = createPaygPromotionReconcileJob({
    env: {},
    recordOutcome: (outcome, count) => outcomes.push([outcome, count]),
    logger: {
      info: (_context, message) => messages.push(message),
    },
  });

  assert.equal(await definition.create({} as JobDeps), null);
  assert.deepEqual(messages, [
    "PAYG promotion reconciliation skipped: AUTUMN_SECRET_KEY is not configured",
  ]);
  assert.deepEqual(outcomes, [["skipped", 1]]);
});
