import { PAYG_PROMOTION_CREDITS, paygPromotionBalanceId } from "@superlog/billing";
import { Autumn, AutumnError } from "autumn-js";
import {
  type PaygPromotionReconciliationDeps,
  reconcilePaygPromotions,
} from "../billing/payg-promotion-reconciliation.js";
import type { JobDefinition } from "../jobs.js";
import { logger } from "../logger.js";

type PaygPromotionReconcileJobOptions = {
  env?: NodeJS.ProcessEnv;
  createProvider?: (secretKey: string) => PaygPromotionReconciliationDeps;
};

function isExistingPromotionBalance(error: unknown, balanceId: string): boolean {
  if (!(error instanceof AutumnError) || error.statusCode !== 409) return false;
  const body = error.body.toLowerCase();
  return (
    body.includes("balance_already_exists") ||
    body.includes("balance already exists") ||
    (body.includes("duplicate") && body.includes(balanceId.toLowerCase()))
  );
}

function createAutumnPaygPromotionProvider(secretKey: string): PaygPromotionReconciliationDeps {
  const autumn = new Autumn({ secretKey });
  return {
    listActivePaygCustomers: async (cursor) => {
      const page = await autumn.customers.list({
        startCursor: cursor,
        limit: 5000,
        plans: [{ id: "payg" }],
        subscriptionStatus: "active",
      });
      return {
        customerIds: page.list.flatMap((customer) => {
          if (!customer.id) return [];
          const balanceId = paygPromotionBalanceId(customer.id);
          const alreadyGranted = customer.balances.investigations?.breakdown?.some(
            (balance) => balance.id === balanceId,
          );
          return alreadyGranted ? [] : [customer.id];
        }),
        nextCursor: page.nextCursor,
      };
    },
    grantPromotion: async (customerId) => {
      const balanceId = paygPromotionBalanceId(customerId);
      try {
        await autumn.balances.create({
          customerId,
          featureId: "investigations",
          includedGrant: PAYG_PROMOTION_CREDITS,
          balanceId,
        });
        return "granted";
      } catch (error) {
        if (isExistingPromotionBalance(error, balanceId)) return "already_granted";
        throw error;
      }
    },
    onGrantError: (customerId, error) => {
      logger.error(
        { scope: "billing.payg-promotion-reconcile", customerId, err: error },
        "failed to reconcile PAYG promotion",
      );
    },
  };
}

export function createPaygPromotionReconcileJob(
  options: PaygPromotionReconcileJobOptions = {},
): JobDefinition {
  return {
    name: "billing.payg-promotion-reconcile",
    schedule: "* * * * *",
    policy: "exclusive",
    expireInSeconds: 110,
    create: () => {
      const secretKey = (options.env ?? process.env).AUTUMN_SECRET_KEY?.trim();
      if (!secretKey) return null;
      const provider = (options.createProvider ?? createAutumnPaygPromotionProvider)(secretKey);
      return async () => {
        const summary = await reconcilePaygPromotions(provider);
        logger.info(
          { scope: "billing.payg-promotion-reconcile", ...summary },
          "PAYG promotions reconciled",
        );
      };
    },
  };
}

export const job = createPaygPromotionReconcileJob();
