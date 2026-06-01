import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PAYG_RATES,
  PLANS,
  RETENTION_DAYS,
  alaCarteValueUsd,
  creditCostUsd,
  creditOverageUsd,
  getPlan,
  packDiscountFraction,
  telemetryOverageUsd,
  telemetryRatePerMillionUsd,
} from "./pricing.js";

test("PAYG rates match the locked pricing decision", () => {
  assert.equal(PAYG_RATES.spansPerMillionUsd, 0.5);
  assert.equal(PAYG_RATES.logsPerMillionUsd, 0.5);
  assert.equal(PAYG_RATES.metricPointsPerMillionUsd, 0.15);
  assert.equal(PAYG_RATES.investigationCreditUsd, 1.5);
});

test("credit rate tapers $1.50 (PAYG) → $1.25 ($150) → $1.00 ($300)", () => {
  assert.equal(getPlan("payg").creditOverageUsd, 1.5);
  assert.equal(getPlan("pack_150").creditOverageUsd, 1.25);
  assert.equal(getPlan("pack_300").creditOverageUsd, 1.0);
  // 40 credits over the $300 pack's allowance → 40 * $1.00 = $40
  assert.equal(creditOverageUsd(getPlan("pack_300"), 40), 40);
});

test("free plan: 5 credits, 1M/5M/10M telemetry, hard block at cap", () => {
  const free = getPlan("free");
  assert.equal(free.baseMonthlyUsd, 0);
  assert.equal(free.includedCredits, 5);
  assert.deepEqual(free.includedTelemetry, {
    spans: 1_000_000,
    logs: 5_000_000,
    metric_points: 10_000_000,
  });
  assert.equal(free.overage, "block");
});

test("pay-as-you-go: no base fee, nothing included, everything metered", () => {
  const payg = getPlan("payg");
  assert.equal(payg.baseMonthlyUsd, 0);
  // PAYG includes the free tier's allowance as free units, then meters beyond.
  assert.equal(payg.includedCredits, 5);
  assert.deepEqual(payg.includedTelemetry, {
    spans: 1_000_000,
    logs: 5_000_000,
    metric_points: 10_000_000,
  });
  assert.equal(payg.overage, "payg");
});

test("power packs are pure credit bundles: telemetry metered, price = credits * rate", () => {
  const p150 = getPlan("pack_150");
  const p300 = getPlan("pack_300");
  assert.equal(p150.baseMonthlyUsd, 150);
  assert.equal(p300.baseMonthlyUsd, 300);
  assert.equal(p150.includedCredits, 120);
  assert.equal(p300.includedCredits, 300);
  for (const pack of [p150, p300]) {
    assert.equal(pack.recurring, true);
    assert.equal(pack.overage, "payg");
    // Telemetry is metered like PAYG, with the same universal free allowance
    // included (so upgrades never bill for free-tier usage).
    assert.deepEqual(pack.includedTelemetry, {
      spans: 1_000_000,
      logs: 5_000_000,
      metric_points: 10_000_000,
    });
    // The pack price is exactly its credits at the tapered rate.
    assert.equal(pack.baseMonthlyUsd, pack.includedCredits * pack.creditOverageUsd);
  }
});

test("pack credits are cheaper than PAYG (the only discount packs give)", () => {
  for (const key of ["pack_150", "pack_300"] as const) {
    const pack = getPlan(key);
    const discount = packDiscountFraction(pack);
    // $150 pack: 120*$1.50=$180 value for $150 → 16.7%. $300 pack: 33.3%.
    assert.ok(discount > 0 && discount < 0.4, `${key} credit discount ${discount.toFixed(3)}`);
    assert.ok(pack.creditOverageUsd < PAYG_RATES.investigationCreditUsd);
  }
});

test("alaCarteValueUsd values a pack's credits at the PAYG rate (no bundled telemetry)", () => {
  const pack = getPlan("pack_150");
  assert.equal(alaCarteValueUsd(pack), pack.includedCredits * PAYG_RATES.investigationCreditUsd);
  assert.equal(alaCarteValueUsd(pack), 180); // 120 * $1.50
});

test("telemetry rate + overage helpers", () => {
  assert.equal(telemetryRatePerMillionUsd("spans"), 0.5);
  assert.equal(telemetryRatePerMillionUsd("metric_points"), 0.15);
  // 2.5M spans over allowance → 2.5 * $0.50 = $1.25
  assert.equal(telemetryOverageUsd("spans", 2_500_000), 1.25);
  assert.equal(creditCostUsd(3), 4.5); // 3 * $1.50
});

test("every plan is keyed by its own key and retention is flat 30d in v1", () => {
  assert.equal(RETENTION_DAYS, 30);
  for (const [key, plan] of Object.entries(PLANS)) {
    assert.equal(plan.key, key);
  }
});
