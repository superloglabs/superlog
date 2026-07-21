// Infrastructure for the usage-limit notifier: the Autumn balance fetch, the
// Postgres dedup-claim + org/member lookups, the Resend email send, and the
// Slack fan-out — wired into the pure notifyOrgUsage() core. Exposes a process
// singleton with a single `notify(orgId)` entry point used by the usage-notify
// job (per active org) and the investigation lifecycle. Stateless, so it's safe
// across worker instances.
//
// Gated on USAGE_NOTIFICATIONS_ENABLED + AUTUMN_SECRET_KEY: otherwise
// createUsageNotifier returns null and every trigger is a no-op (the
// `usageNotifier?.` callers below).
import { currentBillingPeriod, periodKey as toPeriodKey } from "@superlog/billing";
import { db, fetchOrgMemberContacts, schema } from "@superlog/db";
import { and, eq } from "drizzle-orm";
import { postSlackMessage } from "../infra/slack/api.js";
import { fetchSlackTargetsForOrg } from "../infra/slack/incident-messages.js";
import { buildAppUrl } from "../incident-route.js";
import { logger } from "../logger.js";
import { renderUsageEmail } from "./usage-email.js";
import {
  type UsageNotifierDeps,
  isFreePlan,
  mapAutumnFeatures,
  notifyOrgUsage,
} from "./usage-notifier.js";

const log = logger.child({ scope: "billing.usage-notify" });

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:5173";
const MANAGE_BILLING_URL = buildAppUrl(WEB_ORIGIN, "/settings?scope=org&section=billing");
const AUTUMN_BASE_URL = "https://api.useautumn.com/v1";
const RESEND_API_URL = "https://api.resend.com/emails";
const FROM_EMAIL = process.env.SUPERLOG_FROM_EMAIL ?? "Superlog <no-reply@superlog.sh>";
const FETCH_TIMEOUT_MS = 10_000;

type ResendSend = (to: string, subject: string, html: string) => Promise<void>;

// Minimal Resend client (raw fetch, same style as the Slack/Autumn helpers).
// null when RESEND_API_KEY is unset — email is then skipped (Slack still posts).
function createResendSend(apiKey: string, fetchImpl: typeof fetch): ResendSend {
  return async (to, subject, html) => {
    const res = await fetchImpl(RESEND_API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM_EMAIL, to: [to], subject, html }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`resend -> ${res.status}`);
  };
}

const MAX_THRESHOLD = 100;

// Calendar-month dedup window (anchor day 1). Slightly independent of each org's
// Autumn reset day, which keeps the math simple; the safe direction is that an
// org maxed mid-cycle is reminded at most once per calendar month.
function currentPeriodKey(now: () => Date): string {
  return toPeriodKey(currentBillingPeriod(now(), 1));
}

async function fetchAutumnCustomer(
  secretKey: string,
  orgId: string,
  fetchImpl: typeof fetch,
): Promise<unknown | null> {
  try {
    const res = await fetchImpl(`${AUTUMN_BASE_URL}/customers/${encodeURIComponent(orgId)}`, {
      headers: { Authorization: `Bearer ${secretKey}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    // 404 = org not provisioned yet; any non-2xx → skip (fail open, no warning).
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    log.warn(
      { orgId, err: err instanceof Error ? err.message : String(err) },
      "autumn customer fetch failed; skipping usage notification",
    );
    return null;
  }
}

function buildDeps(
  secretKey: string,
  fetchImpl: typeof fetch,
  now: () => Date,
  resendSend: ResendSend | null,
): UsageNotifierDeps {
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
      const customer = await fetchAutumnCustomer(secretKey, orgId, fetchImpl);
      if (!customer) return null;
      // Free plan only — never warn/enforce a paying org, even if one of their
      // features is hard-capped without overage (e.g. a grandfathered plan).
      if (!isFreePlan(customer)) return null;
      const balances = mapAutumnFeatures(customer);
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
      // No Resend key configured → skip email (the Slack post still happens).
      if (!resendSend) return;
      const { subject, html } = renderUsageEmail({
        orgName: event.orgName,
        feature: event.feature,
        pct: event.pct,
        threshold: event.threshold,
        enforcement: event.enforcement,
        manageBillingUrl: event.manageBillingUrl,
        balances: event.balances,
      });
      await resendSend(event.email, subject, html);
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
  // Evaluate one org and fire any newly-crossed threshold notification. Called
  // per active org by the usage-notify job, and directly by the investigation
  // lifecycle. Stateless — no process-local queue, so it's safe across worker
  // instances.
  notify: (orgId: string) => Promise<void>;
};

export function createUsageNotifier(
  opts: {
    secretKey?: string | null;
    resendKey?: string | null;
    enabled?: boolean;
    fetchImpl?: typeof fetch;
    now?: () => Date;
  } = {},
): UsageNotifier | null {
  // Dedicated on-switch, independent of metering (AUTUMN_SECRET_KEY): deploying
  // this code is inert until USAGE_NOTIFICATIONS_ENABLED is flipped, so the
  // ledger can be primed first and existing over-cap orgs aren't blasted on
  // rollout. See the prime-usage-notifications script.
  const enabled = opts.enabled ?? process.env.USAGE_NOTIFICATIONS_ENABLED === "true";
  if (!enabled) return null;
  const secretKey = (opts.secretKey ?? process.env.AUTUMN_SECRET_KEY)?.trim();
  if (!secretKey) return null;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const resendKey = (opts.resendKey ?? process.env.RESEND_API_KEY)?.trim();
  const resendSend = resendKey ? createResendSend(resendKey, fetchImpl) : null;
  const deps = buildDeps(secretKey, fetchImpl, opts.now ?? (() => new Date()), resendSend);

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

  return { notify: run };
}

// Process singleton: used directly by the investigation lifecycle and per-org by
// the `usage-notify` pg-boss job (which derives active orgs from ClickHouse, so
// nothing process-local is relied on). null when billing/notifications are off.
export const usageNotifier: UsageNotifier | null = createUsageNotifier();
