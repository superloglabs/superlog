// Infrastructure for the usage-limit notifier: the Autumn balance fetch, the
// Postgres dedup-claim + org/member lookups, the Loops email-event sender, and
// the Slack fan-out — wired into the pure notifyOrgUsage() core. Also exposes a
// process singleton (enqueue from the telemetry meter, notify directly from the
// investigation lifecycle) and an interval-gated drainer for createWorkerTick.
//
// Gated on AUTUMN_SECRET_KEY: with no billing provider configured there are no
// caps to warn against, so createUsageNotifier returns null and every trigger
// is a no-op (the `usageNotifier?.` callers below).
import {
  type FeatureBalance,
  currentBillingPeriod,
  periodKey as toPeriodKey,
} from "@superlog/billing";
import { db, fetchOrgMemberContacts, schema, sendLoopsUsageThresholdEvent } from "@superlog/db";
import { and, eq } from "drizzle-orm";
import { postSlackMessage } from "../infra/slack/api.js";
import { fetchSlackTargetsForOrg } from "../infra/slack/incident-messages.js";
import { logger } from "../logger.js";
import { type UsageNotifierDeps, mapAutumnFeatures, notifyOrgUsage } from "./usage-notifier.js";

const log = logger.child({ scope: "billing.usage-notify" });

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:5173";
const MANAGE_BILLING_URL = `${WEB_ORIGIN}/settings?scope=org&section=billing`;
const AUTUMN_BASE_URL = "https://api.useautumn.com/v1";
const FETCH_TIMEOUT_MS = 10_000;
// Drain on a slower cadence than the 60s telemetry meter — usage moves slowly
// relative to a cap, and this bounds the per-tick Autumn /customers call volume.
const DEFAULT_NOTIFIER_INTERVAL_MS = 5 * 60 * 1000;

const MAX_THRESHOLD = 100;

// Calendar-month dedup window (anchor day 1). Slightly independent of each org's
// Autumn reset day, which keeps the math simple; the safe direction is that an
// org maxed mid-cycle is reminded at most once per calendar month.
function currentPeriodKey(now: () => Date): string {
  return toPeriodKey(currentBillingPeriod(now(), 1));
}

async function fetchAutumnBalances(
  secretKey: string,
  orgId: string,
  fetchImpl: typeof fetch,
): Promise<FeatureBalance[] | null> {
  try {
    const res = await fetchImpl(`${AUTUMN_BASE_URL}/customers/${encodeURIComponent(orgId)}`, {
      headers: { Authorization: `Bearer ${secretKey}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    // 404 = org not provisioned yet; any non-2xx → skip (fail open, no warning).
    if (!res.ok) return null;
    return mapAutumnFeatures(await res.json());
  } catch (err) {
    log.warn(
      { orgId, err: err instanceof Error ? err.message : String(err) },
      "autumn balance fetch failed; skipping usage notification",
    );
    return null;
  }
}

function buildDeps(secretKey: string, fetchImpl: typeof fetch, now: () => Date): UsageNotifierDeps {
  return {
    periodKey: () => currentPeriodKey(now),

    hasMaxNotified: async (orgId, periodKey) => {
      const rows = await db
        .select({ id: schema.usageNotifications.id })
        .from(schema.usageNotifications)
        .where(
          and(
            eq(schema.usageNotifications.orgId, orgId),
            eq(schema.usageNotifications.periodKey, periodKey),
            eq(schema.usageNotifications.threshold, MAX_THRESHOLD),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },

    fetchOrgUsage: async (orgId) => {
      const balances = await fetchAutumnBalances(secretKey, orgId, fetchImpl);
      if (!balances) return null;
      const rows = await db
        .select({ name: schema.orgs.name })
        .from(schema.orgs)
        .where(eq(schema.orgs.id, orgId))
        .limit(1);
      return { orgName: rows[0]?.name ?? "Your organization", balances };
    },

    // Atomic claim: insert one row per step, ignore conflicts, and return the
    // rows that were actually inserted — i.e. the steps this call won.
    claimThresholds: async (orgId, periodKey, thresholds, feature) => {
      if (thresholds.length === 0) return [];
      const inserted = await db
        .insert(schema.usageNotifications)
        .values(thresholds.map((threshold) => ({ orgId, periodKey, threshold, feature })))
        .onConflictDoNothing({
          target: [
            schema.usageNotifications.orgId,
            schema.usageNotifications.periodKey,
            schema.usageNotifications.threshold,
          ],
        })
        .returning({ threshold: schema.usageNotifications.threshold });
      return inserted.map((r) => r.threshold);
    },

    fetchMembers: (orgId) => fetchOrgMemberContacts(orgId),

    sendUsageEvent: async (event) => {
      await sendLoopsUsageThresholdEvent({
        email: event.email,
        userId: event.userId,
        orgId: event.orgId,
        orgName: event.orgName,
        feature: event.feature,
        pct: event.pct,
        threshold: event.threshold,
        enforcement: event.enforcement,
        manageBillingUrl: event.manageBillingUrl,
      });
    },

    postSlack: async (orgId, text) => {
      const targets = await fetchSlackTargetsForOrg(orgId);
      for (const target of targets) {
        await postSlackMessage({ target, text });
      }
    },

    enforcement: process.env.BILLING_ENFORCEMENT_ENABLED === "true",
    manageBillingUrl: MANAGE_BILLING_URL,
  };
}

export type UsageNotifier = {
  // Queue an org for evaluation on the next drain (used by the telemetry meter).
  enqueue: (orgId: string) => void;
  // Evaluate one org now (used by the investigation lifecycle).
  notify: (orgId: string) => Promise<void>;
  // Evaluate + clear the queued orgs; returns how many were processed.
  drain: () => Promise<number>;
};

export function createUsageNotifier(
  opts: { secretKey?: string | null; fetchImpl?: typeof fetch; now?: () => Date } = {},
): UsageNotifier | null {
  const secretKey = (opts.secretKey ?? process.env.AUTUMN_SECRET_KEY)?.trim();
  if (!secretKey) return null;
  const deps = buildDeps(secretKey, opts.fetchImpl ?? fetch, opts.now ?? (() => new Date()));
  const pending = new Set<string>();

  const run = async (orgId: string): Promise<void> => {
    try {
      await notifyOrgUsage(deps, orgId);
    } catch (err) {
      log.error(
        { orgId, err: err instanceof Error ? err.message : String(err) },
        "usage notification evaluation failed",
      );
    }
  };

  return {
    enqueue: (orgId) => {
      pending.add(orgId);
    },
    notify: run,
    drain: async () => {
      if (pending.size === 0) return 0;
      const orgs = [...pending];
      pending.clear();
      for (const orgId of orgs) await run(orgId);
      return orgs.length;
    },
  };
}

// Process singleton: enqueued by the telemetry meter, notified directly by the
// investigation lifecycle. null when billing is unconfigured.
export const usageNotifier: UsageNotifier | null = createUsageNotifier();

// Interval-gated drainer for createWorkerTick. null when there's no notifier.
export function createUsageNotifierTick(
  notifier: UsageNotifier | null = usageNotifier,
  opts: { intervalMs?: number; now?: () => number } = {},
): (() => Promise<number>) | null {
  if (!notifier) return null;
  const intervalMs = opts.intervalMs ?? DEFAULT_NOTIFIER_INTERVAL_MS;
  const nowMs = opts.now ?? Date.now;
  let nextRunAt = 0;
  let running = false;
  return async () => {
    const current = nowMs();
    if (running || current < nextRunAt) return 0;
    running = true;
    nextRunAt = current + intervalMs;
    try {
      return await notifier.drain();
    } finally {
      running = false;
    }
  };
}
