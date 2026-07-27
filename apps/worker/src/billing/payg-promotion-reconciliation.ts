type PromotionResult = "granted" | "already_granted";

type ActivePaygCustomerPage = {
  customerIds: string[];
  nextCursor: string | null;
};

export type PaygPromotionReconciliationDeps = {
  listActivePaygCustomers: (cursor?: string) => Promise<ActivePaygCustomerPage>;
  grantPromotion: (customerId: string) => Promise<PromotionResult>;
  onGrantError?: (customerId: string, error: unknown) => void;
};

export type PaygPromotionReconciliationSummary = {
  examined: number;
  granted: number;
  alreadyGranted: number;
  failed: number;
};

export async function reconcilePaygPromotions(
  deps: PaygPromotionReconciliationDeps,
): Promise<PaygPromotionReconciliationSummary> {
  const summary: PaygPromotionReconciliationSummary = {
    examined: 0,
    granted: 0,
    alreadyGranted: 0,
    failed: 0,
  };
  let cursor: string | undefined;

  do {
    const page = await deps.listActivePaygCustomers(cursor);
    for (const customerId of page.customerIds) {
      summary.examined += 1;
      try {
        const result = await deps.grantPromotion(customerId);
        if (result === "granted") summary.granted += 1;
        else summary.alreadyGranted += 1;
      } catch (error) {
        summary.failed += 1;
        deps.onGrantError?.(customerId, error);
      }
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);

  return summary;
}
