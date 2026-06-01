// The locked pricing model for Superlog cloud, encoded as typed domain
// constants so the worker (metering/enforcement), the api (Stripe, read), and
// the proxy (ingest gate) all agree on one source of truth.
//
// Model: Free → Pay-as-you-go → two discounted "power packs" ($150 / $300).
//   - Telemetry (spans / logs / metric points) is metered per signal with
//     separate per-million rates.
//   - Investigations are credits: 1 investigation run = 1 credit.
//   - Packs bundle telemetry + credits at a discount; overage spills to PAYG.
//   - Free hard-blocks ingest at its cap; everything else meters as PAYG.
//
// Pricing rationale lives in the team's pricing strawman; if a number changes
// here, change it there too.

export type SignalType = "spans" | "logs" | "metric_points";

export const SIGNAL_TYPES: readonly SignalType[] = ["spans", "logs", "metric_points"];

export type PlanKey = "free" | "payg" | "pack_150" | "pack_300";

// Pay-as-you-go unit prices. Telemetry is priced per 1,000,000 events; an
// investigation credit is a flat per-run price.
//
// The credit price is $1.50 against a measured marginal cost of ~$1.28 per
// completed investigation — Sonnet-only since 2026-05-18, reconciled against
// the Anthropic Admin API cost report, not our (6x-low) internal telemetry.
// (~$1.00 if you exclude the ~24% failed-run tax we also pay.) So $1.50 is a
// real but modest margin. Packs taper the per-credit rate down to reward
// commitment (see each plan's creditOverageUsd).
export const PAYG_RATES = {
  spansPerMillionUsd: 0.5,
  logsPerMillionUsd: 0.5,
  metricPointsPerMillionUsd: 0.15,
  investigationCreditUsd: 1.5,
} as const;

// v1 ships a single retention window for every plan: per-tenant TTL is not yet
// implemented in ClickHouse (infra/aws/modules/clickhouse-ha sets a flat
// ttl=30). Differentiated retention is a later feature; until then no plan may
// advertise more or less than this.
export const RETENTION_DAYS = 30;

// Included telemetry per billing period, expressed in raw event counts (not
// millions) to keep enforcement comparisons exact.
export type SignalAllowance = Record<SignalType, number>;

export type Plan = {
  key: PlanKey;
  displayName: string;
  // Fixed recurring price per period. 0 for free and for pure PAYG.
  baseMonthlyUsd: number;
  // Investigation credits granted at the start of each period.
  includedCredits: number;
  // Price per investigation credit consumed beyond the included allowance.
  // PAYG charges the base rate; packs taper it down to reward commitment.
  // Ignored when overage === "block" (free never bills credits, it blocks).
  creditOverageUsd: number;
  // Telemetry included each period. null means "nothing included, everything
  // metered" (pure pay-as-you-go).
  includedTelemetry: SignalAllowance | null;
  // Behaviour once an included allowance is exhausted.
  //   "block" — refuse further ingest (free tier).
  //   "payg"  — keep accepting and bill the overage at PAYG_RATES.
  overage: "block" | "payg";
  // Whether the plan renews automatically each period.
  recurring: boolean;
};

export const PLANS: Record<PlanKey, Plan> = {
  free: {
    key: "free",
    displayName: "Free",
    baseMonthlyUsd: 0,
    includedCredits: 5,
    creditOverageUsd: PAYG_RATES.investigationCreditUsd, // unused: free blocks
    includedTelemetry: { spans: 1_000_000, logs: 5_000_000, metric_points: 10_000_000 },
    overage: "block",
    recurring: true,
  },
  payg: {
    key: "payg",
    displayName: "Pay as you go",
    baseMonthlyUsd: 0,
    // The free tier's allowance is included on every paid plan as free units,
    // then metered beyond. This is what lets us carry usage across plan changes
    // (so a maxed-out cap can't be reset by toggling Free↔paid) WITHOUT billing
    // anyone for their free-tier usage: the carried usage lands inside these
    // included units. Free blocks at the same allowance; paid plans meter past it.
    includedCredits: 5,
    creditOverageUsd: PAYG_RATES.investigationCreditUsd, // $1.50 beyond the 5 free
    includedTelemetry: { spans: 1_000_000, logs: 5_000_000, metric_points: 10_000_000 },
    overage: "payg",
    recurring: true,
  },
  // A "pack" is a prepaid monthly bucket of investigation credits at a tapered
  // per-credit rate; the pack price is exactly includedCredits * creditOverageUsd
  // so the headline is honest ($150 = 120 @ $1.25 · $300 = 300 @ $1.00). Telemetry
  // is metered identically on every paid plan, with the same free allowance
  // included as PAYG (see the payg note) so upgrades never bill for free-tier use.
  pack_150: {
    key: "pack_150",
    displayName: "Pro",
    baseMonthlyUsd: 150,
    includedCredits: 120,
    creditOverageUsd: 1.25,
    includedTelemetry: { spans: 1_000_000, logs: 5_000_000, metric_points: 10_000_000 },
    overage: "payg",
    recurring: true,
  },
  pack_300: {
    key: "pack_300",
    displayName: "Max",
    baseMonthlyUsd: 300,
    includedCredits: 300,
    creditOverageUsd: 1.0,
    includedTelemetry: { spans: 1_000_000, logs: 5_000_000, metric_points: 10_000_000 },
    overage: "payg",
    recurring: true,
  },
};

// Deep-freeze the catalog: getPlan hands out shared references, so a frozen
// plan prevents an accidental mutation from globally changing billing behavior.
for (const plan of Object.values(PLANS)) {
  if (plan.includedTelemetry) Object.freeze(plan.includedTelemetry);
  Object.freeze(plan);
}

export function getPlan(key: PlanKey): Plan {
  return PLANS[key];
}

export function telemetryRatePerMillionUsd(signal: SignalType): number {
  switch (signal) {
    case "spans":
      return PAYG_RATES.spansPerMillionUsd;
    case "logs":
      return PAYG_RATES.logsPerMillionUsd;
    case "metric_points":
      return PAYG_RATES.metricPointsPerMillionUsd;
  }
}

// Cost of `events` of a given signal at PAYG rates.
export function telemetryOverageUsd(signal: SignalType, events: number): number {
  return (events / 1_000_000) * telemetryRatePerMillionUsd(signal);
}

// Cost of `credits` investigation credits at the base PAYG rate. This is also
// the reference rate for the pack-discount comparison (à-la-carte == PAYG).
export function creditCostUsd(credits: number): number {
  return credits * PAYG_RATES.investigationCreditUsd;
}

// Cost of `credits` consumed beyond a plan's included allowance, at that plan's
// (possibly discounted) per-credit overage rate.
export function creditOverageUsd(plan: Plan, credits: number): number {
  return credits * plan.creditOverageUsd;
}

// What the plan's included CREDITS would cost if bought à la carte at the PAYG
// rate — the denominator for the pack discount. Telemetry is excluded: the
// included telemetry allowance is the universal free tier (the same on every
// plan, see PLANS), not pack-specific value, so it doesn't factor into the
// pack's discount.
export function alaCarteValueUsd(plan: Plan): number {
  return creditCostUsd(plan.includedCredits);
}

// Fraction saved by buying the pack instead of the same volume à la carte.
// 0 when the à-la-carte value is 0 (nothing to discount).
export function packDiscountFraction(plan: Plan): number {
  const alaCarte = alaCarteValueUsd(plan);
  if (alaCarte <= 0) return 0;
  return 1 - plan.baseMonthlyUsd / alaCarte;
}
