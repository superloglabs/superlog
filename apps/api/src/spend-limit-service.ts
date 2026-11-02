import {
  type SpendLimitCustomer,
  type SpendLimitDeps,
  type SpendLimitValidation,
  currentBillUsd,
  minimumSpendLimitUsd,
  nextBillingReset,
  readSpendLimit,
  reconcileSpendLimit,
  validateSpendLimit,
} from "@superlog/billing";
import { db, schema } from "@superlog/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger.js";

type RejectionReason = Extract<SpendLimitValidation, { ok: false }>["reason"] | "unavailable";

export class SpendLimitRejected extends Error {
  constructor(readonly reason: RejectionReason) {
    super(reason);
  }
}

export type SpendLimitView = {
  // False when the org's plan can't carry a limit (Free, custom) or billing
  // can't be read right now.
  available: boolean;
  minimumUsd: number | null;
  limitUsd: number | null;
  status: "none" | "under" | "reached";
  billUsd: number | null;
  pct: number | null;
  resetsAt: number | null;
};

export const SPEND_LIMIT_UNAVAILABLE: SpendLimitView = {
  available: false,
  minimumUsd: null,
  limitUsd: null,
  status: "none",
  billUsd: null,
  pct: null,
  resetsAt: null,
};

export type SpendLimitStore = {
  get: (orgId: string) => Promise<number | null>;
  save: (orgId: string, cents: number) => Promise<void>;
  remove: (orgId: string) => Promise<void>;
};

export function createSpendLimitStore(): SpendLimitStore {
  return {
    get: async (orgId) => {
      const row = await db.query.orgSpendLimits.findFirst({
        where: eq(schema.orgSpendLimits.orgId, orgId),
        columns: { monthlyLimitCents: true },
      });
      return row?.monthlyLimitCents ?? null;
    },
    save: async (orgId, cents) => {
      await db
        .insert(schema.orgSpendLimits)
        .values({ orgId, monthlyLimitCents: cents })
        .onConflictDoUpdate({
          target: schema.orgSpendLimits.orgId,
          set: { monthlyLimitCents: cents, updatedAt: new Date() },
        });
    },
    remove: async (orgId) => {
      await db
        .update(schema.orgSpendLimits)
        .set({ monthlyLimitCents: null, updatedAt: new Date() })
        .where(eq(schema.orgSpendLimits.orgId, orgId));
    },
  };
}

export function createSpendLimitService(deps: {
  store: SpendLimitStore;
  billing: SpendLimitDeps;
}) {
  const { store, billing } = deps;

  async function measure(
    orgId: string,
    customer: SpendLimitCustomer,
    limitCents: number | null,
  ): Promise<SpendLimitView> {
    const minimumUsd = minimumSpendLimitUsd(customer.planId);
    const billUsd = currentBillUsd(customer);
    if (minimumUsd === null || billUsd === null) return SPEND_LIMIT_UNAVAILABLE;
    const state = await readSpendLimit(
      { loadCustomer: async () => customer },
      { orgId, limitCents },
    );
    const limited = state.status === "under" || state.status === "reached";
    return {
      available: true,
      minimumUsd,
      limitUsd: limited ? state.limitUsd : null,
      status: limited ? state.status : "none",
      billUsd,
      pct: limited ? state.pct : null,
      resetsAt: nextBillingReset(customer.balances),
    };
  }

  return {
    read: async (orgId: string): Promise<SpendLimitView> => {
      const customer = await billing.loadCustomer(orgId);
      if (!customer) return SPEND_LIMIT_UNAVAILABLE;
      return measure(orgId, customer, await store.get(orgId));
    },

    set: async (orgId: string, cents: number): Promise<SpendLimitView> => {
      const customer = await billing.loadCustomer(orgId);
      if (!customer) throw new SpendLimitRejected("unavailable");
      const validation = validateSpendLimit(customer.planId, cents);
      if (!validation.ok) throw new SpendLimitRejected(validation.reason);

      await store.save(orgId, cents);
      try {
        await reconcileSpendLimit(billing, { orgId, limitCents: cents });
      } catch (err) {
        // The row is the customer's intent, so the limit stands and the next
        // scheduled pass applies it.
        logger.warn(
          { scope: "billing.spend-limit", orgId, err },
          "spend limit saved but not yet applied",
        );
      }
      return measure(orgId, customer, cents);
    },

    // The scheduled pass drops the row once it has lifted any freeze, which also
    // covers a failed lift here and a pass already in flight.
    remove: async (orgId: string): Promise<void> => {
      await store.remove(orgId);
      try {
        await reconcileSpendLimit(billing, { orgId, limitCents: null });
      } catch (err) {
        logger.warn(
          { scope: "billing.spend-limit", orgId, err },
          "spend limit removed but freeze not yet lifted",
        );
      }
    },
  };
}
