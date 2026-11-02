// Scheduled job: enforce every org's monthly spend limit. Runs on the same minute
// cadence as usage metering, so a limit trips within a minute or two of the usage
// that crossed it. Each pass is idempotent and derives everything from billing
// balances, which is also what lifts a freeze when a new cycle starts.
//
// Opts out when billing or BILLING_SPEND_LIMITS_ENABLED is off.
import { type SpendLimitDeps, type SpendLimitState, reconcileSpendLimit } from "@superlog/billing";
import type { DB } from "@superlog/db";
import * as schema from "@superlog/db/schema";
import {
  createSpendLimitBilling,
  defaultNotifySpendLimit,
  spendLimitSecretKey,
} from "../billing/spend-limit-infra.js";
import type { JobDefinition } from "../jobs.js";
import { logger } from "../logger.js";

const log = logger.child({ scope: "billing.spend-limit" });

type OrgLimit = { orgId: string; monthlyLimitCents: number };

type Measured = Extract<SpendLimitState, { status: "under" | "reached" }>;

function loadOrgLimits(db: DB): Promise<OrgLimit[]> {
  return db
    .select({
      orgId: schema.orgSpendLimits.orgId,
      monthlyLimitCents: schema.orgSpendLimits.monthlyLimitCents,
    })
    .from(schema.orgSpendLimits);
}

export function createSpendLimitJob(
  options: {
    env?: Record<string, string | undefined>;
    createBilling?: (secretKey: string) => SpendLimitDeps;
    loadLimits?: (db: DB) => Promise<OrgLimit[]>;
    notify?: (input: { orgId: string; limitCents: number; state: Measured }) => Promise<void>;
  } = {},
): JobDefinition {
  const env = options.env ?? process.env;
  const createBilling = options.createBilling ?? createSpendLimitBilling;
  const loadLimits = options.loadLimits ?? loadOrgLimits;
  const notify = options.notify ?? defaultNotifySpendLimit;

  return {
    name: "spend-limit",
    schedule: "* * * * *",
    create: ({ db }) => {
      const secretKey = spendLimitSecretKey(env);
      if (!secretKey) return null;
      return async () => {
        const billing = createBilling(secretKey);
        for (const { orgId, monthlyLimitCents } of await loadLimits(db)) {
          try {
            const state = await reconcileSpendLimit(billing, {
              orgId,
              limitCents: monthlyLimitCents,
            });
            if (state.status === "under" || state.status === "reached") {
              await notify({ orgId, limitCents: monthlyLimitCents, state });
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
