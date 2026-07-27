type PromotionResult = "granted" | "already_granted";

type ActivePaygCustomerPage = {
  customerIds: string[];
  nextCursor: string | null;
};

export type PaygPromotionReconciliationDeps = {
  grantConcurrency?: number;
  maxCustomers?: number;
  listActivePaygCustomers: (cursor?: string) => Promise<ActivePaygCustomerPage>;
  grantPromotion: (customerId: string) => Promise<PromotionResult>;
  onGrantError?: (customerId: string, error: unknown) => void;
  onPageError?: (error: unknown) => void;
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
  const grantConcurrency = Math.max(1, Math.floor(deps.grantConcurrency ?? 25));
  const maxCustomers = Math.max(0, Math.floor(deps.maxCustomers ?? Number.POSITIVE_INFINITY));
  let cursor: string | undefined;

  do {
    let page: ActivePaygCustomerPage;
    try {
      page = await deps.listActivePaygCustomers(cursor);
    } catch (error) {
      summary.failed += 1;
      deps.onPageError?.(error);
      break;
    }
    const remainingCustomerBudget = maxCustomers - summary.examined;
    const customerIds = page.customerIds.slice(0, remainingCustomerBudget);
    for (let offset = 0; offset < customerIds.length; offset += grantConcurrency) {
      const batch = customerIds.slice(offset, offset + grantConcurrency);
      summary.examined += batch.length;
      await Promise.all(
        batch.map(async (customerId) => {
          try {
            const result = await deps.grantPromotion(customerId);
            if (result === "granted") summary.granted += 1;
            else summary.alreadyGranted += 1;
          } catch (error) {
            summary.failed += 1;
            deps.onGrantError?.(customerId, error);
          }
        }),
      );
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor && summary.examined < maxCustomers);

  return summary;
}
