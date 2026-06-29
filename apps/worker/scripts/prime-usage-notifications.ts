// One-off cold-start helper for usage-limit notifications.
//
//   pnpm --filter @superlog/worker exec tsx scripts/prime-usage-notifications.ts
//   pnpm --filter @superlog/worker exec tsx scripts/prime-usage-notifications.ts --clear-100
//
// Default (prime): before flipping USAGE_NOTIFICATIONS_ENABLED on, claim the
// 50% and 85% steps for the CURRENT period for every org already over them —
// WITHOUT sending — so existing long-over-cap orgs aren't blasted with stale
// "approaching" emails on rollout. The 100% step is deliberately NOT claimed, so
// orgs already at the cap still receive the one "you've reached your limit"
// email (their genuine warning before enforcement).
//
// --clear-100: at the moment BILLING_ENFORCEMENT_ENABLED is flipped on, delete
// the current period's 100% rows so the notifier re-sends with the enforcement-
// aware "ingest paused" copy — the real event of being blocked.
//
// Requires DATABASE_URL + AUTUMN_SECRET_KEY. Idempotent (onConflictDoNothing).
import {
  currentBillingPeriod,
  highestWatermark,
  periodKey,
  thresholdsAtOrBelow,
} from "@superlog/billing";
import { db, schema } from "@superlog/db";
import { and, eq } from "drizzle-orm";
import { mapAutumnFeatures } from "../src/billing/usage-notifier.js";

const AUTUMN_BASE_URL = "https://api.useautumn.com/v1";

async function fetchBalances(secretKey: string, orgId: string) {
  try {
    const res = await fetch(`${AUTUMN_BASE_URL}/customers/${encodeURIComponent(orgId)}`, {
      headers: { Authorization: `Bearer ${secretKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return mapAutumnFeatures(await res.json());
  } catch {
    return null;
  }
}

async function main() {
  const secretKey = process.env.AUTUMN_SECRET_KEY?.trim();
  if (!process.env.DATABASE_URL || !secretKey) {
    console.error("DATABASE_URL and AUTUMN_SECRET_KEY are required");
    process.exit(1);
  }
  const pk = periodKey(currentBillingPeriod(new Date(), 1));

  if (process.argv.includes("--clear-100")) {
    const deleted = await db
      .delete(schema.usageNotifications)
      .where(
        and(
          eq(schema.usageNotifications.periodKey, pk),
          eq(schema.usageNotifications.threshold, 100),
        ),
      )
      .returning({ id: schema.usageNotifications.id });
    console.log(`cleared ${deleted.length} threshold=100 rows for period ${pk}`);
    process.exit(0);
  }

  const orgs = await db.select({ id: schema.orgs.id }).from(schema.orgs);
  console.log(`priming 50/85 for ${orgs.length} orgs, period ${pk}`);
  let primed = 0;
  let claimedRows = 0;
  for (const { id: orgId } of orgs) {
    const balances = await fetchBalances(secretKey, orgId);
    if (!balances) continue;
    const wm = highestWatermark(balances);
    if (!wm) continue; // paid / unlimited / under-configured
    const steps = thresholdsAtOrBelow(wm.pct).filter((t) => t < 100); // 50/85 only
    if (steps.length === 0) continue;
    const inserted = await db
      .insert(schema.usageNotifications)
      .values(
        steps.map((threshold) => ({ orgId, periodKey: pk, threshold, feature: wm.featureId })),
      )
      .onConflictDoNothing({
        target: [
          schema.usageNotifications.orgId,
          schema.usageNotifications.periodKey,
          schema.usageNotifications.threshold,
        ],
      })
      .returning({ threshold: schema.usageNotifications.threshold });
    if (inserted.length > 0) {
      primed += 1;
      claimedRows += inserted.length;
    }
  }
  console.log(`primed ${primed} orgs (${claimedRows} rows claimed)`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
