// Usage-limit notifier — PURE core (no DB / network imports so it's unit-testable
// in isolation, same split as usage-metering.ts vs usage-meter-ticker.ts). Given
// an org id, it reads the org's current per-feature balances, computes the single
// highest watermark across hard-capped (Free) features, and — if a new 50/85/100%
// step has been crossed this period — fires a Loops email event to every member
// and a Slack message to the org's connected channels. The concrete Autumn /
// Postgres / Loops / Slack adapters live in usage-notifier-ticker.ts.
//
// Everything is best-effort and fails closed-to-silent: billing notifications must
// never break the worker tick. The dedup claim (claimThresholds) is the source of
// truth for "already notified" — see the usage_notifications table.
import { type FeatureBalance, highestWatermark, thresholdsAtOrBelow } from "@superlog/billing";
import { logger } from "../logger.js";

const log = logger.child({ scope: "billing.usage-notify" });

// Human labels for the metered features in user-facing copy.
const FEATURE_LABELS: Record<string, string> = {
  spans: "spans",
  logs: "logs",
  metric_points: "metric points",
  investigations: "investigations",
};
export function featureLabel(featureId: string): string {
  return FEATURE_LABELS[featureId] ?? featureId;
}

// The metered features we read balances for (must match autumn.config.ts /
// SIGNAL_FEATURE_IDS + the investigations credit feature).
export const USAGE_FEATURE_IDS = ["spans", "logs", "metric_points", "investigations"] as const;

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Map an Autumn `GET /v1/customers/{id}` response body to our FeatureBalance[].
// Pure + defensive: Autumn's REST balance field names are read with fallbacks
// (the exact shape should be confirmed against a live response — see the verify
// step). A feature missing from the response is simply skipped.
export function mapAutumnFeatures(body: unknown): FeatureBalance[] {
  const features = (body as { features?: Record<string, unknown> } | null)?.features;
  if (!features || typeof features !== "object") return [];
  const out: FeatureBalance[] = [];
  for (const featureId of USAGE_FEATURE_IDS) {
    const f = (features as Record<string, Record<string, unknown>>)[featureId];
    if (!f || typeof f !== "object") continue;
    const granted = num(f.included_usage ?? f.included ?? f.allowance ?? f.granted ?? f.limit);
    const usage = num(f.usage ?? f.used);
    out.push({
      featureId,
      usage,
      granted,
      overageAllowed: f.overage_allowed === true || f.overageAllowed === true,
      unlimited: f.unlimited === true,
    });
  }
  return out;
}

// Structured payload handed to the Loops event sender (the email copy lives in a
// Loops workflow keyed on `threshold` / `enforcement`, not in this repo).
export type UsageNotificationEvent = {
  orgId: string;
  orgName: string;
  email: string;
  userId: string;
  feature: string;
  pct: number;
  threshold: number;
  enforcement: boolean;
  manageBillingUrl: string;
};

export type UsageNotifierDeps = {
  // Stable dedup key for the current billing period ("YYYY-MM-DD").
  periodKey: () => string;
  // Cheap short-circuit: has the 100% step already fired this period? Lets us
  // skip the Autumn round-trip for orgs already maxed out.
  hasMaxNotified: (orgId: string, periodKey: string) => Promise<boolean>;
  // Current usage snapshot from the billing provider; null on error/unprovisioned.
  fetchOrgUsage: (orgId: string) => Promise<{ orgName: string; balances: FeatureBalance[] } | null>;
  // Atomically claim the given threshold steps for (org, period); returns the
  // subset that were NOT already claimed (i.e. newly won by this call).
  claimThresholds: (
    orgId: string,
    periodKey: string,
    thresholds: number[],
    feature: string,
  ) => Promise<number[]>;
  fetchMembers: (orgId: string) => Promise<Array<{ userId: string; email: string }>>;
  sendUsageEvent: (event: UsageNotificationEvent) => Promise<void>;
  postSlack: (orgId: string, text: string) => Promise<void>;
  enforcement: boolean;
  manageBillingUrl: string;
};

export type NotifyStatus =
  | "already_maxed"
  | "no_usage"
  | "not_capped"
  | "below_threshold"
  | "already_notified"
  | "sent";

export type NotifyResult = {
  status: NotifyStatus;
  threshold?: number;
  feature?: string;
  pct?: number;
};

// The Slack message for a crossed threshold. Pure so it can be unit-tested and
// reused. 50/85% = approaching warning; 100% = limit reached, wording depends on
// whether enforcement (hard-blocking) is actually active.
export function buildUsageSlackText(opts: {
  orgName: string;
  feature: string;
  pct: number;
  threshold: number;
  enforcement: boolean;
  manageBillingUrl: string;
}): string {
  const label = featureLabel(opts.feature);
  const link = `<${opts.manageBillingUrl}|Upgrade>`;
  if (opts.threshold < 100) {
    return `:chart_with_upwards_trend: *${opts.orgName}* has used ${opts.pct}% of its Free plan ${label} this month. ${link} to avoid hitting the limit.`;
  }
  if (opts.enforcement) {
    const paused =
      opts.feature === "investigations"
        ? "new investigations are paused"
        : `new ${label} are being dropped`;
    return `:credit_card: *${opts.orgName}* has hit its Free plan ${label} limit — ${paused}. ${link} to resume.`;
  }
  return `:warning: *${opts.orgName}* has reached its Free plan ${label} limit. ${link} to avoid interruption to ingest and investigations.`;
}

// Evaluate one org and fire a notification if a new threshold step was crossed.
// Safe to call repeatedly (dedup via claimThresholds) and from multiple triggers
// (telemetry meter tick + investigation lifecycle).
export async function notifyOrgUsage(
  deps: UsageNotifierDeps,
  orgId: string,
): Promise<NotifyResult> {
  const periodKey = deps.periodKey();

  if (await deps.hasMaxNotified(orgId, periodKey)) {
    return { status: "already_maxed" };
  }

  const usage = await deps.fetchOrgUsage(orgId);
  if (!usage) return { status: "no_usage" };

  const wm = highestWatermark(usage.balances);
  if (!wm) return { status: "not_capped" };

  const toClaim = thresholdsAtOrBelow(wm.pct);
  if (toClaim.length === 0) return { status: "below_threshold", pct: wm.pct };

  // Claim every step at-or-below the current watermark in one shot; only the
  // highest newly-won step is actually sent, so a usage spike straight to 100%
  // marks 50/85 silently and a late lower-step notice can never arrive after it.
  const newly = await deps.claimThresholds(orgId, periodKey, toClaim, wm.featureId);
  if (newly.length === 0) return { status: "already_notified", pct: wm.pct };

  const threshold = Math.max(...newly);

  // Email: one Loops event per member. Best-effort per recipient.
  const members = await deps.fetchMembers(orgId);
  for (const member of members) {
    try {
      await deps.sendUsageEvent({
        orgId,
        orgName: usage.orgName,
        email: member.email,
        userId: member.userId,
        feature: wm.featureId,
        pct: wm.pct,
        threshold,
        enforcement: deps.enforcement,
        manageBillingUrl: deps.manageBillingUrl,
      });
    } catch (err) {
      log.error(
        { orgId, email: member.email, err: err instanceof Error ? err.message : String(err) },
        "usage notification email event failed",
      );
    }
  }

  // Slack: a single message to the org's connected channel(s).
  try {
    await deps.postSlack(
      orgId,
      buildUsageSlackText({
        orgName: usage.orgName,
        feature: wm.featureId,
        pct: wm.pct,
        threshold,
        enforcement: deps.enforcement,
        manageBillingUrl: deps.manageBillingUrl,
      }),
    );
  } catch (err) {
    log.error(
      { orgId, err: err instanceof Error ? err.message : String(err) },
      "usage notification slack post failed",
    );
  }

  log.info(
    { orgId, threshold, feature: wm.featureId, pct: wm.pct, members: members.length },
    "usage threshold notification sent",
  );
  return { status: "sent", threshold, feature: wm.featureId, pct: wm.pct };
}
