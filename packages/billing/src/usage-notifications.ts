// Usage-threshold notification domain — PURE (no I/O). Decides, from an org's
// current per-feature balances, whether a "you're approaching / hit your Free
// limit" notification is due and at which step.
//
// Single highest-watermark model: we don't notify per feature. We take the most
// utilized hard-capped feature, derive one percentage, and fire at most once per
// step (50 / 85 / 100) per billing period. The notifier persists which steps
// have fired (see apps/worker usage-notifier + the usage_notifications table).
//
// Scope is Free-tier (hard-capped) features only: a paid plan meters past its
// allowance (overageAllowed) and is billed by Autumn rather than warned, and an
// unlimited/internal plan never approaches a cap. Both are excluded here.

// Notification steps, ascending. 100 = at/over the cap.
export const THRESHOLDS = [50, 85, 100] as const;
export type Threshold = (typeof THRESHOLDS)[number];

// One metered feature's current-period balance, as read from the billing
// provider. `granted` is the included allowance (the hard cap on Free).
export type FeatureBalance = {
  featureId: string;
  usage: number;
  granted: number;
  // true on paid plans (meter past the allowance) — not a hard cap, so excluded.
  overageAllowed: boolean;
  // true on unlimited/internal plans — no cap to approach, excluded.
  unlimited: boolean;
};

// Is this a Free-tier hard cap we should warn against? Paid/unlimited features
// and features with no real allowance (granted <= 0) are not.
function isHardCapped(b: FeatureBalance): boolean {
  return !b.unlimited && !b.overageAllowed && b.granted > 0;
}

// The single highest utilization across an org's hard-capped features, as an
// integer percentage, plus which feature is driving it. null when the org has
// no hard-capped feature (paid/unlimited/unconfigured) — i.e. nothing to warn.
export function highestWatermark(
  balances: FeatureBalance[],
): { pct: number; featureId: string } | null {
  let best: { pct: number; featureId: string } | null = null;
  for (const b of balances) {
    if (!isHardCapped(b)) continue;
    const pct = Math.floor((b.usage / b.granted) * 100);
    if (!best || pct > best.pct) best = { pct, featureId: b.featureId };
  }
  return best;
}

// Every threshold step at or below the given percentage. The notifier claims
// all of these at once so a lower step can never fire after a higher one (e.g.
// a usage spike straight to 100% must not later emit a stale "50%" notice).
export function thresholdsAtOrBelow(pct: number): Threshold[] {
  return THRESHOLDS.filter((t) => pct >= t);
}

// The single step to actually send: the highest crossed threshold that hasn't
// already been notified this period. null when nothing new has been crossed.
export function nextThresholdToFire(
  pct: number,
  alreadyNotified: readonly number[],
): Threshold | null {
  const notified = new Set(alreadyNotified);
  for (const t of [...THRESHOLDS].reverse()) {
    if (pct >= t && !notified.has(t)) return t;
  }
  return null;
}
