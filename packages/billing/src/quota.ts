// Pure quota decisions shared by the enforcement points: the proxy ingest gate
// (telemetry) and the worker's investigation gate (credits). All inputs are
// plain numbers the caller has already loaded for the current billing period —
// this module never touches a database or ClickHouse.

import { type Plan, type SignalType, telemetryOverageUsd } from "./pricing.js";

export type TelemetryQuotaDecision =
  | { allowed: true; overageEvents: number; overageUsd: number }
  | { allowed: false; reason: "over_free_cap" };

// Decide whether `incoming` more events of `signal` may be ingested, given how
// much of that signal the org has already used this period.
//
//   overage === "block" (free): refuse once cumulative usage reaches the cap.
//   overage === "payg"  (payg/packs): always accept; bill only the slice of
//     this batch that lands above the included allowance.
export function evaluateTelemetryQuota(input: {
  plan: Plan;
  signal: SignalType;
  alreadyUsed: number;
  incoming: number;
}): TelemetryQuotaDecision {
  const included = input.plan.includedTelemetry?.[input.signal] ?? 0;

  if (input.plan.overage === "block") {
    // Block once already at the cap, OR when this batch would push past it —
    // otherwise a single large `incoming` batch sails through while cumulative
    // usage is still under the cap.
    if (input.alreadyUsed >= included || input.alreadyUsed + input.incoming > included) {
      return { allowed: false, reason: "over_free_cap" };
    }
    return { allowed: true, overageEvents: 0, overageUsd: 0 };
  }

  const remainingIncluded = Math.max(0, included - input.alreadyUsed);
  const overageEvents = Math.max(0, input.incoming - remainingIncluded);
  return {
    allowed: true,
    overageEvents,
    overageUsd: telemetryOverageUsd(input.signal, overageEvents),
  };
}

export type CreditQuotaDecision =
  | { allowed: true; billable: boolean }
  | { allowed: false; reason: "no_credits" };

// Decide whether an investigation (1 credit) may run. `granted` is the credits
// available this period (plan-included + any purchased), `consumed` is how many
// have already been used.
//
//   remaining >= 1 → run against a granted credit (not separately billable).
//   out of credits + overage "payg" → run and bill at the PAYG credit rate.
//   out of credits + overage "block" (free) → refuse.
export function evaluateCreditQuota(input: {
  plan: Plan;
  granted: number;
  consumed: number;
}): CreditQuotaDecision {
  const remaining = input.granted - input.consumed;
  if (remaining >= 1) return { allowed: true, billable: false };
  if (input.plan.overage === "payg") return { allowed: true, billable: true };
  return { allowed: false, reason: "no_credits" };
}
