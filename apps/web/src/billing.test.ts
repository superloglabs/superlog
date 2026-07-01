import assert from "node:assert/strict";
import test from "node:test";
import { type EntitlementBalance, signalAtHardCap } from "./billing.ts";

// A `check` stand-in that returns a fixed balance.
const checkReturning = (balance: EntitlementBalance) => () => ({ balance });

const hardCapBalance = {
  unlimited: false,
  granted: 1_000_000,
  overageAllowed: false,
  usage: 1_000_000,
};

test("signalAtHardCap is true only when a bounded, non-overage signal has caught up to its allowance", () => {
  assert.equal(signalAtHardCap(checkReturning(hardCapBalance), "spans"), true);
  assert.equal(
    signalAtHardCap(checkReturning({ ...hardCapBalance, usage: 1_500_000 }), "spans"),
    true,
  );
});

test("signalAtHardCap is false when the signal is under its cap", () => {
  assert.equal(
    signalAtHardCap(checkReturning({ ...hardCapBalance, usage: 999_999 }), "spans"),
    false,
  );
});

test("signalAtHardCap is false for unlimited, unbounded, or overage-allowed signals", () => {
  assert.equal(
    signalAtHardCap(checkReturning({ ...hardCapBalance, unlimited: true }), "spans"),
    false,
  );
  assert.equal(signalAtHardCap(checkReturning({ ...hardCapBalance, granted: 0 }), "spans"), false);
  assert.equal(
    signalAtHardCap(checkReturning({ ...hardCapBalance, overageAllowed: true }), "spans"),
    false,
  );
});

test("signalAtHardCap is false when there's no balance", () => {
  assert.equal(signalAtHardCap(checkReturning(null), "spans"), false);
  assert.equal(signalAtHardCap(checkReturning(undefined), "spans"), false);
});

// The regression this guard exists for: autumn-js's check() reads
// `customer.flags[featureId]` with no guard, so a brand-new org whose Autumn
// customer is truthy but has no `flags` yet makes check() throw
// "Cannot read properties of undefined (reading 'spans')". That threw during
// AuthenticatedApp's render and black-screened the app right after a fresh user
// created their first org. signalAtHardCap must swallow it and report "not
// capped" (fail-open) so a half-loaded customer never crashes the app.
test("signalAtHardCap returns false (never throws) when check() throws", () => {
  const throwingCheck = () => {
    throw new TypeError("Cannot read properties of undefined (reading 'spans')");
  };
  assert.doesNotThrow(() => signalAtHardCap(throwingCheck, "spans"));
  assert.equal(signalAtHardCap(throwingCheck, "spans"), false);
});
