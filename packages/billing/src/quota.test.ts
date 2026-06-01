import assert from "node:assert/strict";
import { test } from "node:test";
import { getPlan } from "./pricing.js";
import { evaluateCreditQuota, evaluateTelemetryQuota } from "./quota.js";

test("free plan accepts telemetry below the cap with no overage", () => {
  const d = evaluateTelemetryQuota({
    plan: getPlan("free"),
    signal: "spans",
    alreadyUsed: 500_000,
    incoming: 100_000,
  });
  assert.deepEqual(d, { allowed: true, overageEvents: 0, overageUsd: 0 });
});

test("free plan hard-blocks once the cap is reached", () => {
  const d = evaluateTelemetryQuota({
    plan: getPlan("free"),
    signal: "spans",
    alreadyUsed: 1_000_000, // exactly at the 1M span cap
    incoming: 1,
  });
  assert.deepEqual(d, { allowed: false, reason: "over_free_cap" });
});

test("pay-as-you-go includes the free allowance, then bills the overage", () => {
  const d = evaluateTelemetryQuota({
    plan: getPlan("payg"),
    signal: "spans",
    alreadyUsed: 0,
    incoming: 2_000_000,
  });
  assert.equal(d.allowed, true);
  assert.ok(d.allowed);
  assert.equal(d.overageEvents, 1_000_000); // first 1M free (included), 1M billed
  assert.equal(d.overageUsd, 0.5); // 1M * $0.50/M
});

test("packs include the same free telemetry allowance, then meter beyond it", () => {
  const d = evaluateTelemetryQuota({
    plan: getPlan("pack_150"),
    signal: "spans",
    alreadyUsed: 0,
    incoming: 2_000_000,
  });
  assert.ok(d.allowed);
  assert.equal(d.overageEvents, 1_000_000); // first 1M free, 1M billed
  assert.equal(d.overageUsd, 0.5);
});

test("a plan WITH an included telemetry allowance bills only the slice above it", () => {
  // No current plan bundles telemetry, but the quota logic still supports it.
  const planWithAllowance = {
    ...getPlan("payg"),
    includedTelemetry: { spans: 60_000_000, logs: 0, metric_points: 0 },
  };
  const d = evaluateTelemetryQuota({
    plan: planWithAllowance,
    signal: "spans",
    alreadyUsed: 59_000_000,
    incoming: 3_000_000, // 1M within allowance, 2M overage
  });
  assert.ok(d.allowed);
  assert.equal(d.overageEvents, 2_000_000);
  assert.equal(d.overageUsd, 1);
});

test("free plan allows investigations until included credits run out, then blocks", () => {
  const free = getPlan("free");
  assert.deepEqual(evaluateCreditQuota({ plan: free, granted: 5, consumed: 4 }), {
    allowed: true,
    billable: false,
  });
  assert.deepEqual(evaluateCreditQuota({ plan: free, granted: 5, consumed: 5 }), {
    allowed: false,
    reason: "no_credits",
  });
});

test("packs spill investigations to PAYG once granted credits are spent", () => {
  const pack = getPlan("pack_150");
  assert.deepEqual(evaluateCreditQuota({ plan: pack, granted: 25, consumed: 25 }), {
    allowed: true,
    billable: true,
  });
});

test("pure PAYG always allows investigations, always billable", () => {
  assert.deepEqual(evaluateCreditQuota({ plan: getPlan("payg"), granted: 0, consumed: 0 }), {
    allowed: true,
    billable: true,
  });
});
