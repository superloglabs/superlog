import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type FeatureBalance,
  THRESHOLDS,
  highestWatermark,
  nextThresholdToFire,
  thresholdsAtOrBelow,
} from "./usage-notifications.js";

// A hard-capped (Free) feature: not unlimited, no overage allowed, finite grant.
function capped(featureId: string, usage: number, granted: number): FeatureBalance {
  return { featureId, usage, granted, overageAllowed: false, unlimited: false };
}

test("THRESHOLDS are the three notification steps in ascending order", () => {
  assert.deepEqual([...THRESHOLDS], [50, 85, 100]);
});

test("highestWatermark returns floor(usage/granted*100) for a single capped feature", () => {
  assert.deepEqual(highestWatermark([capped("spans", 500_000, 1_000_000)]), {
    pct: 50,
    featureId: "spans",
  });
  // 854_999 / 1_000_000 = 85.4999% → floors to 85
  assert.deepEqual(highestWatermark([capped("spans", 854_999, 1_000_000)]), {
    pct: 85,
    featureId: "spans",
  });
});

test("highestWatermark picks the most-utilized feature across many", () => {
  const r = highestWatermark([
    capped("spans", 200_000, 1_000_000), // 20%
    capped("logs", 4_500_000, 5_000_000), // 90%
    capped("metric_points", 1_000_000, 10_000_000), // 10%
  ]);
  assert.deepEqual(r, { pct: 90, featureId: "logs" });
});

test("highestWatermark caps the reported pct at over-100 usage but stays >=100", () => {
  const r = highestWatermark([capped("investigations", 7, 5)]);
  assert.ok(r);
  assert.ok(r.pct >= 100);
  assert.equal(r.featureId, "investigations");
});

test("highestWatermark ignores paid (overageAllowed) and unlimited features", () => {
  // Paid org: usage past grant but overage allowed → not a hard cap → no watermark.
  assert.equal(
    highestWatermark([
      {
        featureId: "spans",
        usage: 9_000_000,
        granted: 1_000_000,
        overageAllowed: true,
        unlimited: false,
      },
    ]),
    null,
  );
  assert.equal(
    highestWatermark([
      { featureId: "logs", usage: 9_000_000, granted: 0, overageAllowed: false, unlimited: true },
    ]),
    null,
  );
  // granted 0 (no allowance configured) is not a real cap → skipped.
  assert.equal(highestWatermark([capped("spans", 5, 0)]), null);
});

test("highestWatermark returns null when there are no balances", () => {
  assert.equal(highestWatermark([]), null);
});

test("thresholdsAtOrBelow returns every threshold <= pct", () => {
  assert.deepEqual(thresholdsAtOrBelow(49), []);
  assert.deepEqual(thresholdsAtOrBelow(50), [50]);
  assert.deepEqual(thresholdsAtOrBelow(84), [50]);
  assert.deepEqual(thresholdsAtOrBelow(85), [50, 85]);
  assert.deepEqual(thresholdsAtOrBelow(100), [50, 85, 100]);
  assert.deepEqual(thresholdsAtOrBelow(140), [50, 85, 100]);
});

test("nextThresholdToFire returns the highest crossed threshold not yet notified", () => {
  assert.equal(nextThresholdToFire(90, []), 85);
  assert.equal(nextThresholdToFire(90, [50]), 85);
  assert.equal(nextThresholdToFire(90, [50, 85]), null); // 100 not crossed yet
  assert.equal(nextThresholdToFire(100, [50, 85]), 100);
  assert.equal(nextThresholdToFire(49, []), null); // below the first step
});

test("a jump straight to 100% fires only 100 (50 and 85 are subsumed)", () => {
  // The notifier marks thresholdsAtOrBelow(pct) as claimed but only SENDS the
  // top one, so a late 50%/85% can never arrive after the 100% notice.
  assert.equal(nextThresholdToFire(100, []), 100);
  assert.deepEqual(thresholdsAtOrBelow(100), [50, 85, 100]);
});
