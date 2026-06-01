// Autumn pricing config (config-as-code) — run `atmn push` to provision these
// products in our Autumn project + Stripe.
//
// The NUMBERS are mirrored from packages/billing/src/pricing.ts (the source of
// truth that also drives the marketing pricing page); this file expresses the
// same locked model in Autumn's DSL. If a price changes, change it in both.
//
// Model: Free → Pay-as-you-go → two power packs. Telemetry (spans / logs /
// metric points) is metered per-million on every PAID plan (decoupled — packs
// bundle no telemetry). Investigations are credits: 1 per completed run, granted
// per plan with a monthly reset and a tapered per-credit overage
// ($1.50 PAYG → $1.25 pack-150 → $1.00 pack-300). Free hard-caps everything
// (no overage price → check() denies once exhausted).
import { feature, item, plan } from "atmn";

// ── Features ─────────────────────────────────────────────────────────────────
export const spans = feature({ id: "spans", name: "Spans", type: "metered", consumable: true });
export const logs = feature({ id: "logs", name: "Logs", type: "metered", consumable: true });
export const metricPoints = feature({
  id: "metric_points",
  name: "Metric points",
  type: "metered",
  consumable: true,
});
export const investigations = feature({
  id: "investigations",
  name: "Investigation credits",
  type: "metered",
  consumable: true,
});

// Telemetry metered identically on every paid plan, with the SAME free
// allowance the Free tier gets included as free units (then billed beyond).
// This is what lets us carry usage across plan changes — so a maxed-out cap
// can't be reset by toggling Free↔paid — WITHOUT billing anyone for free-tier
// usage: the carried usage lands inside these included units. Fresh items per
// plan to avoid shared mutation. Priced items omit `reset`: the monthly
// `price.interval` already defines the period (Autumn rejects having both).
const telemetryItems = () => [
  item({
    featureId: spans.id,
    included: 1_000_000,
    price: { amount: 0.5, interval: "month", billingUnits: 1_000_000, billingMethod: "usage_based" },
  }),
  item({
    featureId: logs.id,
    included: 5_000_000,
    price: { amount: 0.5, interval: "month", billingUnits: 1_000_000, billingMethod: "usage_based" },
  }),
  item({
    featureId: metricPoints.id,
    included: 10_000_000,
    price: { amount: 0.15, interval: "month", billingUnits: 1_000_000, billingMethod: "usage_based" },
  }),
];

// ── Plans (mutually exclusive — same group) ──────────────────────────────────
export const free = plan({
  id: "free",
  name: "Free",
  group: "main",
  // NOTE: mark "Free" as the DEFAULT product in the Autumn dashboard so new orgs
  // are auto-assigned it (config-as-code doesn't carry the default flag). Until
  // then an un-provisioned org returns 404 on check() and the gate fails open.
  //
  // NOTE: also set `reset_usage_when_enabled = false` on EACH Free item below
  // (dashboard, or `autumn.plans.update({planId:"free", items:[...]})` — the SDK
  // accepts it, but atmn's DSL has no field for it and `plans.get` doesn't echo
  // it). This makes usage CARRY OVER when an org cancels a paid plan and reverts
  // to Free, instead of resetting to 0 — otherwise a user can toggle paid→Free
  // to mint a fresh free allowance ("infinite money glitch"). Cancel itself is
  // apps/api `/api/me/billing/cancel` → `billing.update(cancelAction:
  // "cancel_immediately")`. Leave the PAID plans' items at the default (reset on
  // enable) so an upgrade from Free starts a clean meter and we never bill for
  // free-tier usage. CAVEAT: `atmn push` rewrites these items WITHOUT the flag,
  // so re-apply it after any push.
  items: [
    // No price on any item → hard cap: check() denies once the allowance is hit.
    item({ featureId: investigations.id, included: 5, reset: { interval: "month" } }),
    item({ featureId: spans.id, included: 1_000_000, reset: { interval: "month" } }),
    item({ featureId: logs.id, included: 5_000_000, reset: { interval: "month" } }),
    item({ featureId: metricPoints.id, included: 10_000_000, reset: { interval: "month" } }),
  ],
});

export const payg = plan({
  id: "payg",
  name: "Pay as you go",
  group: "main",
  items: [
    // 5 free investigations (same as Free), then $1.50 each.
    item({
      featureId: investigations.id,
      included: 5,
      price: { amount: 1.5, interval: "month", billingUnits: 1, billingMethod: "usage_based" },
    }),
    ...telemetryItems(),
  ],
});

export const pack150 = plan({
  id: "pack_150",
  name: "Pro",
  group: "main",
  price: { amount: 150, interval: "month" },
  items: [
    // $150/mo includes 120 investigations; beyond that $1.25 each.
    item({
      featureId: investigations.id,
      included: 120,
      price: { amount: 1.25, interval: "month", billingUnits: 1, billingMethod: "usage_based" },
    }),
    ...telemetryItems(),
  ],
});

export const pack300 = plan({
  id: "pack_300",
  name: "Max",
  group: "main",
  price: { amount: 300, interval: "month" },
  items: [
    // $300/mo includes 300 investigations; beyond that $1.00 each.
    item({
      featureId: investigations.id,
      included: 300,
      price: { amount: 1.0, interval: "month", billingUnits: 1, billingMethod: "usage_based" },
    }),
    ...telemetryItems(),
  ],
});
