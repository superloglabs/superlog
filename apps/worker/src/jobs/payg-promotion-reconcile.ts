import { metrics } from "@opentelemetry/api";
import { PAYG_PROMOTION_CREDITS, paygPromotionBalanceId } from "@superlog/billing";
import type { DB } from "@superlog/db";
import * as schema from "@superlog/db/schema";
import { Autumn, AutumnError } from "autumn-js";
import { eq } from "drizzle-orm";
import {
  type PaygPromotionReconciliationDeps,
  reconcilePaygPromotions,
} from "../billing/payg-promotion-reconciliation.js";
import type { JobDefinition } from "../jobs.js";
import { logger as defaultLogger } from "../logger.js";

type PromotionOutcome = "granted" | "already_granted" | "failed" | "skipped";
type LoggerLike = {
  info: (context: Record<string, unknown>, message: string) => void;
};

const meter = metrics.getMeter("@superlog/worker/billing");
const AUTUMN_REQUEST_TIMEOUT_MS = 10_000;
const PAYG_GRANT_CONCURRENCY = 25;
const PAYG_MAX_CUSTOMERS_PER_RUN = 5_000;
const promotionExaminedCounter = meter.createCounter("superlog.billing.payg_promotion.examined", {
  description: "Active PAYG customers examined during promotion reconciliation.",
  unit: "1",
});
const promotionOutcomeCounter = meter.createCounter("superlog.billing.payg_promotion.outcomes", {
  description: "PAYG promotion reconciliation outcomes.",
  unit: "1",
});

type PaygPromotionReconcileJobOptions = {
  env?: NodeJS.ProcessEnv;
  createProvider?: (secretKey: string) => PaygPromotionReconciliationDeps;
  logger?: LoggerLike;
  recordExamined?: (count: number) => void;
  recordOutcome?: (outcome: PromotionOutcome, count: number) => void;
  cursorStore?: PaygPromotionCursorStore;
};

type PaygPromotionCursorStore = {
  load: () => Promise<string | undefined>;
  save: (cursor: string | null) => Promise<void>;
};

const PAYG_PROMOTION_CURSOR_NAME = "billing_payg_promotion_reconcile";

function createPaygPromotionCursorStore(database: DB): PaygPromotionCursorStore {
  return {
    load: async () => {
      const row = await database.query.workerState.findFirst({
        where: eq(schema.workerState.name, PAYG_PROMOTION_CURSOR_NAME),
      });
      return row?.cursorKey;
    },
    save: async (cursor) => {
      if (cursor === null) {
        await database
          .delete(schema.workerState)
          .where(eq(schema.workerState.name, PAYG_PROMOTION_CURSOR_NAME));
        return;
      }
      const now = new Date();
      await database
        .insert(schema.workerState)
        .values({
          name: PAYG_PROMOTION_CURSOR_NAME,
          cursor: now,
          cursorKey: cursor,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: schema.workerState.name,
          set: { cursorKey: cursor, updatedAt: now },
        });
    },
  };
}

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
  const autumn = new Autumn({ secretKey, timeoutMs: AUTUMN_REQUEST_TIMEOUT_MS });
  return {
    grantConcurrency: PAYG_GRANT_CONCURRENCY,
    maxCustomers: PAYG_MAX_CUSTOMERS_PER_RUN,
    listActivePaygCustomers: async (cursor, limit) => {
      const page = await autumn.customers.list({
        startCursor: cursor,
        limit,
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
        scanned: page.list.length,
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
      defaultLogger.error(
        { scope: "billing.payg-promotion-reconcile", customerId, err: error },
        "failed to reconcile PAYG promotion",
      );
    },
    onPageError: (error) => {
      defaultLogger.error(
        { scope: "billing.payg-promotion-reconcile", err: error },
        "failed to list active PAYG customers",
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
    // Each pass is capped at 5,000 customers: roughly 34 minutes at 25-way
    // concurrency and the SDK's 10-second request timeout. A durable provider
    // cursor resumes the next pass at the following page, while a completed
    // sweep resets the cursor so newly eligible customers are discovered.
    expireInSeconds: 3_600,
    create: (deps) => {
      const logger = options.logger ?? defaultLogger;
      const recordOutcome =
        options.recordOutcome ??
        ((outcome: PromotionOutcome, count: number) => {
          promotionOutcomeCounter.add(count, { outcome });
        });
      const recordExamined =
        options.recordExamined ?? ((count: number) => promotionExaminedCounter.add(count));
      const secretKey = (options.env ?? process.env).AUTUMN_SECRET_KEY?.trim();
      if (!secretKey) {
        logger.info(
          { scope: "billing.payg-promotion-reconcile" },
          "PAYG promotion reconciliation skipped: AUTUMN_SECRET_KEY is not configured",
        );
        recordOutcome("skipped", 1);
        return null;
      }
      const provider = (options.createProvider ?? createAutumnPaygPromotionProvider)(secretKey);
      const cursorStore = options.cursorStore ?? createPaygPromotionCursorStore(deps.db);
      return async () => {
        logger.info(
          { scope: "billing.payg-promotion-reconcile" },
          "PAYG promotion reconciliation started",
        );
        const summary = await reconcilePaygPromotions({
          ...provider,
          loadCursor: cursorStore.load,
          saveCursor: cursorStore.save,
        });
        if (summary.examined > 0) recordExamined(summary.examined);
        if (summary.granted > 0) recordOutcome("granted", summary.granted);
        if (summary.alreadyGranted > 0) {
          recordOutcome("already_granted", summary.alreadyGranted);
        }
        if (summary.failed > 0) recordOutcome("failed", summary.failed);
        logger.info(
          { scope: "billing.payg-promotion-reconcile", ...summary },
          "PAYG promotions reconciled",
        );
      };
    },
  };
}

export const job = createPaygPromotionReconcileJob();
