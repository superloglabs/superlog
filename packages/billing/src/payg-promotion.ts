export const PAYG_PROMOTION_CREDITS = 100;

export function paygPromotionBalanceId(customerId: string): string {
  return `payg-welcome-investigations-${customerId}`;
}

export type PaygSubscription = {
  planId: string;
  status: string;
};

type PromotionBalance = {
  customerId: string;
  featureId: "investigations";
  includedGrant: number;
  balanceId: string;
};

export type PaygPromotionDeps = {
  loadSubscriptions: (customerId: string) => Promise<PaygSubscription[]>;
  createPromotionBalance: (input: PromotionBalance) => Promise<"created" | "already_exists">;
};

export type PaygPromotionResult = "granted" | "already_granted" | "not_eligible";

export async function ensurePaygPromotion(
  deps: PaygPromotionDeps,
  customerId: string,
): Promise<PaygPromotionResult> {
  const subscriptions = await deps.loadSubscriptions(customerId);
  const eligible = subscriptions.some(
    (subscription) => subscription.planId === "payg" && subscription.status === "active",
  );
  if (!eligible) return "not_eligible";

  const result = await deps.createPromotionBalance({
    customerId,
    featureId: "investigations",
    includedGrant: PAYG_PROMOTION_CREDITS,
    balanceId: paygPromotionBalanceId(customerId),
    // No reset: this is a single non-renewing grant, stacked on the monthly
    // PAYG allowance rather than replenished with it.
  });
  return result === "created" ? "granted" : "already_granted";
}
