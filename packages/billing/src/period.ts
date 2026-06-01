// Billing periods are monthly windows anchored on the day a subscription began
// (calendar months when the anchor is the 1st). Metering rollups, credit
// grants, and quota resets are all keyed to the period a moment falls in.
//
// Once Stripe is the system of record (Phase 3) the authoritative period bounds
// come from the subscription; this pure math is what the worker uses to bucket
// usage and what we fall back to for plans without a live subscription (free).

export type BillingPeriod = { start: Date; end: Date };

// Anchor days are clamped to 1–28 so every month actually has the day — the
// same trick Stripe uses to avoid "the 31st" disappearing in February.
function clampAnchorDay(day: number): number {
  if (!Number.isFinite(day)) return 1;
  return Math.min(28, Math.max(1, Math.floor(day)));
}

// The period [start, end) that contains `now`, in UTC. The period starts at
// 00:00 UTC on the anchor day; `now` exactly at that instant is inside the new
// period (start is inclusive, end exclusive).
export function currentBillingPeriod(now: Date, anchorDay: number): BillingPeriod {
  const anchor = clampAnchorDay(anchorDay);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const dayOfMonth = now.getUTCDate();

  // Before the anchor day → the current period began on the anchor of the
  // previous month. Date.UTC normalises a month index of -1 into the prior year.
  const startMonthOffset = dayOfMonth < anchor ? -1 : 0;
  const start = new Date(Date.UTC(year, month + startMonthOffset, anchor));
  const end = new Date(Date.UTC(year, month + startMonthOffset + 1, anchor));
  return { start, end };
}

// Stable partition key for a period: the UTC calendar date of its start, e.g.
// "2026-05-10". Used as the period column on usage rollups and credit grants.
export function periodKey(period: BillingPeriod): string {
  return period.start.toISOString().slice(0, 10);
}
