// Scheduled job: enforce every org's monthly spend limit. Runs on the same minute
// cadence as usage metering, so a limit trips within a minute or two of the usage
// that crossed it. Each pass is idempotent and derives everything from billing
// balances, which is also what lifts a freeze when a new cycle starts.
//
// Opts out when billing isn't configured. With BILLING_SPEND_LIMITS_ENABLED off it
// keeps running to lift any freeze, so disabling the feature can't strand an org
// that had reached its limit. Limits are kept for when the feature returns.
import { type SpendLimitDeps, type SpendLimitState, reconcileSpendLimit } from "@superlog/billing";
import type { DB } from "@superlog/db";
import * as schema from "@superlog/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import {
  createSpendLimitBilling,
  defaultNotifySpendLimit,
  spendLimitSecretKey,
} from "../billing/spend-limit-infra.js";
import type { JobDefinition } from "../jobs.js";
import { logger } from "../logger.js";

const log = logger.child({ scope: "billing.spend-limit" });

type OrgLimit = { orgId: string; monthlyLimitCents: number | null };

type Measured = Extract<SpendLimitState, { status: "under" | "reached" }>;

function loadOrgLimits(db: DB): Promise<OrgLimit[]> {
  return db
    .select({
      orgId: schema.orgSpendLimits.orgId,
      monthlyLimitCents: schema.orgSpendLimits.monthlyLimitCents,
    })
    .from(schema.orgSpendLimits);
}

// Guarded on the null so a limit set again since this pass read it survives.
async function forgetRemovedLimit(db: DB, orgId: string): Promise<void> {
  await db
    .delete(schema.orgSpendLimits)
    .where(
      and(eq(schema.orgSpendLimits.orgId, orgId), isNull(schema.orgSpendLimits.monthlyLimitCents)),
    );
}

export function createSpendLimitJob(
  options: {
    env?: Record<string, string | undefined>;
    createBilling?: (secretKey: string) => SpendLimitDeps;
    loadLimits?: (db: DB) => Promise<OrgLimit[]>;
    forgetRemoved?: (db: DB, orgId: string) => Promise<void>;
    notify?: (input: { orgId: string; limitCents: number; state: Measured }) => Promise<void>;
  } = {},
): JobDefinition {
  const env = options.env ?? process.env;
  const createBilling = options.createBilling ?? createSpendLimitBilling;
  const loadLimits = options.loadLimits ?? loadOrgLimits;
  const forgetRemoved = options.forgetRemoved ?? forgetRemovedLimit;
  const notify = options.notify ?? defaultNotifySpendLimit;

  return {
    name: "spend-limit",
    schedule: "* * * * *",
    create: ({ db }) => {
      const secretKey = env.AUTUMN_SECRET_KEY?.trim();
      if (!secretKey) return null;
      const enabled = spendLimitSecretKey(env) !== null;
      return async () => {
        const billing = createBilling(secretKey);
        for (const { orgId, monthlyLimitCents } of await loadLimits(db)) {
          try {
            const limitCents = enabled ? monthlyLimitCents : null;
            const state = await reconcileSpendLimit(billing, { orgId, limitCents });
            if (monthlyLimitCents === null) await forgetRemoved(db, orgId);
            if (limitCents !== null && (state.status === "under" || state.status === "reached")) {
              await notify({ orgId, limitCents, state });
            }
          } catch (err) {
            log.error(
              { orgId, err: err instanceof Error ? err.message : String(err) },
              "spend limit reconcile failed",
            );
          }
        }
      };
    },
  };
}

export const job = createSpendLimitJob();
