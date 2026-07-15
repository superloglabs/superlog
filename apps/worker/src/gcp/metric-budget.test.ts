import { strict as assert } from "node:assert";
import { test } from "node:test";
import { MetricReadBudget } from "./metric-budget.js";

test("metric reads cannot request more returned series than the persisted monthly allowance", () => {
  const budget = MetricReadBudget.restore({
    month: "2026-07",
    seriesRead: 99_999_750,
    monthlyLimit: 100_000_000,
    now: new Date("2026-07-13T12:00:00Z"),
  });
  assert.equal(budget.remaining, 250);
  assert.equal(budget.nextPageSize(1_000), 250);
  budget.recordReturnedSeries(250);
  assert.equal(budget.remaining, 0);
  assert.equal(budget.nextPageSize(1_000), 0);
  assert.throws(() => budget.recordReturnedSeries(1), /monthly metric read budget exhausted/);
});

test("a new UTC month resets the persisted series counter", () => {
  const budget = MetricReadBudget.restore({
    month: "2026-06",
    seriesRead: 100_000_000,
    monthlyLimit: 100_000_000,
    now: new Date("2026-07-01T00:00:00Z"),
  });
  assert.equal(budget.month, "2026-07");
  assert.equal(budget.seriesRead, 0);
  assert.equal(budget.remaining, 100_000_000);
});
