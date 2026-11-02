// Monthly spend limit: a customer-set dollar ceiling on the bill.
//
// The billing provider only caps overage per feature, in feature units, so the
// dollar decision lives here. Once the estimated bill reaches the limit, every
// feature is frozen at its current overage: check() then denies anything
// billable, track() stops adding to the invoice, and allowance a feature still
// has included stays usable because using it costs nothing. The existing ingest
// and investigation gates need no knowledge of this.
//
// reconcileSpendLimit is stateless and idempotent. It derives the freeze from
// the limit and the provider's balances on every pass, so raising the limit or
// rolling into a new billing cycle lifts the freeze without any stored flag.
import { PLANS, type PlanKey, type SignalType, telemetryRatePerMillionUsd } from "./pricing.js";

// Every feature that can add to a bill (must match autumn.config.ts).
const SIGNAL_FEATURE_IDS = ["spans", "logs", "metric_points"] as const;
const CREDIT_FEATURE_ID = "investigations";
const BILLED_FEATURE_IDS: readonly string[] = [...SIGNAL_FEATURE_IDS, CREDIT_FEATURE_ID];

const FREE_PLAN_ID = "free";
const MINIMUM_LIMIT_CENTS = 100;
// Fits the Postgres integer column.
const MAXIMUM_LIMIT_CENTS = 2_147_483_647;

export const SPEND_LIMIT_WARNING_PCT = 80;

export type SpendLimitBalance = {
  featureId: string;
  usage: number;
  granted: number;
  unlimited: boolean;
  nextResetAt: number | null;
  // Per-grant balances behind the totals above.
  breakdown?: SpendLimitGrant[];
};

type SpendLimitGrant = { usage: number; includedGrant: number; prepaidGrant: number };

export type SpendLimitControl = {
  featureId?: string;
  enabled: boolean;
  overageLimit?: number;
};

export type SpendLimitCustomer = {
  planId: string | null;
  balances: SpendLimitBalance[];
  spendLimits: SpendLimitControl[];
};

export type SpendLimitDeps = {
  // null means the customer can't be read: nothing changes on this pass.
  loadCustomer: (orgId: string) => Promise<SpendLimitCustomer | null>;
  writeSpendLimits: (orgId: string, limits: SpendLimitControl[]) => Promise<void>;
};

export type SpendLimitState =
  | { status: "unavailable" }
  | { status: "inactive" }
  | {
      status: "under" | "reached";
      billUsd: number;
      limitUsd: number;
      pct: number;
      resetsAt: number | null;
    };

export type SpendLimitValidation =
  | { ok: true }
  | { ok: false; reason: "invalid_amount" | "unsupported_plan" | "below_plan_fee" };

// Plans with a bill we can price. Free never bills, and custom plans carry rates
// the catalog doesn't know, so a dollar limit on either would be meaningless.
function isSpendLimitPlan(planId: string | null): planId is PlanKey {
  return planId !== null && planId !== FREE_PLAN_ID && Object.hasOwn(PLANS, planId);
}

const TELEMETRY_BILLING_UNIT = 1_000_000;

// Units the invoice charges for. Overage is per grant: usage that passed a plan's
// allowance stays billable even when a later grant leaves unused credit, which
// the balance's totals would otherwise net away.
export function billableOverage(
  balance: Pick<SpendLimitBalance, "usage" | "granted" | "unlimited" | "breakdown">,
): number {
  if (balance.unlimited) return 0;
  if (!balance.breakdown?.length) return Math.max(0, balance.usage - balance.granted);
  return balance.breakdown.reduce(
    (sum, grant) => sum + Math.max(0, grant.usage - grant.includedGrant - grant.prepaidGrant),
    0,
  );
}

// Telemetry is invoiced in whole million-unit blocks, rounded up.
export function billedTelemetryUsd(signal: SignalType, units: number): number {
  return Math.ceil(units / TELEMETRY_BILLING_UNIT) * telemetryRatePerMillionUsd(signal);
}

export function estimateBillUsd(planKey: PlanKey, balances: SpendLimitBalance[]): number {
  const plan = PLANS[planKey];
  const usageUsd = balances.reduce((sum, balance) => {
    const units = billableOverage(balance);
    if (balance.featureId === CREDIT_FEATURE_ID) return sum + units * plan.creditOverageUsd;
    const signal = SIGNAL_FEATURE_IDS.find((id) => id === balance.featureId);
    return signal ? sum + billedTelemetryUsd(signal, units) : sum;
  }, 0);
  return plan.baseMonthlyUsd + usageUsd;
}

// The bill for a customer's current plan, or null when the plan can't be priced.
export function currentBillUsd(customer: SpendLimitCustomer): number | null {
  return isSpendLimitPlan(customer.planId)
    ? estimateBillUsd(customer.planId, customer.balances)
    : null;
}

export function nextBillingReset(balances: SpendLimitBalance[]): number | null {
  const resets = balances.flatMap(({ nextResetAt }) => (nextResetAt === null ? [] : [nextResetAt]));
  return resets.length > 0 ? Math.min(...resets) : null;
}

export function validateSpendLimit(planId: string | null, cents: number): SpendLimitValidation {
  if (!Number.isInteger(cents) || cents < MINIMUM_LIMIT_CENTS || cents > MAXIMUM_LIMIT_CENTS) {
    return { ok: false, reason: "invalid_amount" };
  }
  if (!isSpendLimitPlan(planId)) return { ok: false, reason: "unsupported_plan" };
  // At or below the fee the limit is already reached on the first day of a cycle.
  const minimumUsd = minimumSpendLimitUsd(planId);
  if (minimumUsd !== null && cents < minimumUsd * 100) {
    return { ok: false, reason: "below_plan_fee" };
  }
  return { ok: true };
}

// The smallest limit a plan accepts, or null when the plan can't carry a limit.
export function minimumSpendLimitUsd(planId: string | null): number | null {
  if (!isSpendLimitPlan(planId)) return null;
  const { baseMonthlyUsd } = PLANS[planId];
  return baseMonthlyUsd > 0 ? baseMonthlyUsd + 1 : MINIMUM_LIMIT_CENTS / 100;
}

export function resolveSpendLimitPlan(
  subscriptions: ReadonlyArray<{ planId: string; status: string }>,
): string | null {
  const active = subscriptions.filter((subscription) => subscription.status === "active");
  const paid = active.find((subscription) => subscription.planId !== FREE_PLAN_ID);
  return (paid ?? active[0])?.planId ?? null;
}

// The freeze for this pass. A feature already frozen lower keeps that value, so
// usage landing after a freeze can't raise it, while a new cycle's lower overage
// replaces last cycle's.
function freezeAtCurrentOverage(customer: SpendLimitCustomer): SpendLimitControl[] {
  const frozen = new Map(
    customer.spendLimits.flatMap((limit) =>
      limit.enabled && limit.featureId !== undefined && limit.overageLimit !== undefined
        ? [[limit.featureId, limit.overageLimit] as const]
        : [],
    ),
  );
  return customer.balances
    .filter((balance) => BILLED_FEATURE_IDS.includes(balance.featureId) && !balance.unlimited)
    .map((balance) => ({
      featureId: balance.featureId,
      enabled: true,
      overageLimit: Math.min(
        billableOverage(balance),
        frozen.get(balance.featureId) ?? Number.POSITIVE_INFINITY,
      ),
    }));
}

function sameFreeze(current: SpendLimitControl[], next: SpendLimitControl[]): boolean {
  return next.every((limit) =>
    current.some(
      (existing) =>
        existing.enabled &&
        existing.featureId === limit.featureId &&
        existing.overageLimit === limit.overageLimit,
    ),
  );
}

export async function reconcileSpendLimit(
  deps: SpendLimitDeps,
  input: { orgId: string; limitCents: number | null },
): Promise<SpendLimitState> {
  const customer = await deps.loadCustomer(input.orgId);
  if (!customer) return { status: "unavailable" };

  const isFrozen = customer.spendLimits.some((limit) => limit.enabled);
  const lift = async () => {
    if (isFrozen) await deps.writeSpendLimits(input.orgId, []);
  };

  const { planId } = customer;
  if (input.limitCents === null || !isSpendLimitPlan(planId)) {
    await lift();
    return { status: "inactive" };
  }

  const billUsd = estimateBillUsd(planId, customer.balances);
  const limitUsd = input.limitCents / 100;
  const measured = {
    billUsd,
    limitUsd,
    pct: Math.floor((billUsd / limitUsd) * 100),
    resetsAt: nextBillingReset(customer.balances),
  };

  if (billUsd < limitUsd) {
    await lift();
    return { status: "under", ...measured };
  }

  const freeze = freezeAtCurrentOverage(customer);
  if (!sameFreeze(customer.spendLimits, freeze)) {
    await deps.writeSpendLimits(input.orgId, freeze);
  }
  return { status: "reached", ...measured };
}

// Measures a customer against a limit without changing anything at the provider.
export function readSpendLimit(
  deps: Pick<SpendLimitDeps, "loadCustomer">,
  input: { orgId: string; limitCents: number | null },
): Promise<SpendLimitState> {
  return reconcileSpendLimit({ ...deps, writeSpendLimits: async () => {} }, input);
}

// Notice ledger key. Keyed by cycle and by limit, so a customer who raises their
// limit is warned again before hitting the new one.
export function spendLimitPeriodKey(
  resetsAt: number | null,
  limitCents: number,
  now: Date,
): string {
  const cycle =
    resetsAt === null
      ? now.toISOString().slice(0, 7)
      : new Date(resetsAt).toISOString().slice(0, 10);
  return `spend:${cycle}:${limitCents}`;
}

export function spendLimitNoticeSteps(state: {
  status: "under" | "reached";
  pct: number;
}): number[] {
  if (state.status === "reached") return [SPEND_LIMIT_WARNING_PCT, 100];
  return state.pct >= SPEND_LIMIT_WARNING_PCT ? [SPEND_LIMIT_WARNING_PCT] : [];
}

// Structural subset of the Autumn SDK client, so this package stays free of the
// SDK dependency and each app passes its own instance.
export type SpendLimitAutumnClient = {
  customers: {
    get(request: { customerId: string }): Promise<{
      subscriptions: ReadonlyArray<{ planId: string; status: string }>;
      balances: Record<
        string,
        Omit<SpendLimitBalance, "breakdown"> & { breakdown?: SpendLimitGrant[] }
      >;
      billingControls?: { spendLimits?: SpendLimitControl[] };
    }>;
    update(request: {
      customerId: string;
      billingControls: { spendLimits: SpendLimitControl[] };
    }): Promise<unknown>;
  };
};

function isMissingCustomer(err: unknown): boolean {
  return (err as { statusCode?: unknown } | null)?.statusCode === 404;
}

export function createAutumnSpendLimitDeps(client: SpendLimitAutumnClient): SpendLimitDeps {
  return {
    loadCustomer: async (orgId) => {
      try {
        const customer = await client.customers.get({ customerId: orgId });
        return {
          planId: resolveSpendLimitPlan(customer.subscriptions),
          balances: Object.values(customer.balances).map((balance) => ({
            featureId: balance.featureId,
            usage: balance.usage,
            granted: balance.granted,
            unlimited: balance.unlimited,
            nextResetAt: balance.nextResetAt,
            ...(balance.breakdown && {
              breakdown: balance.breakdown.map(({ usage, includedGrant, prepaidGrant }) => ({
                usage,
                includedGrant,
                prepaidGrant,
              })),
            }),
          })),
          spendLimits: customer.billingControls?.spendLimits ?? [],
        };
      } catch (err) {
        if (isMissingCustomer(err)) return null;
        throw err;
      }
    },
    writeSpendLimits: async (orgId, limits) => {
      await client.customers.update({
        customerId: orgId,
        billingControls: { spendLimits: limits },
      });
    },
  };
}
