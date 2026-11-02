// Infrastructure for spend limits: the Autumn client, the Postgres limit and
// ledger reads, and Resend + Slack delivery, wired into the pure notifier and the
// reconcile in @superlog/billing.
import { type SpendLimitDeps, createAutumnSpendLimitDeps, readSpendLimit } from "@superlog/billing";
import { db, fetchOrgMemberContacts, schema } from "@superlog/db";
import { Autumn } from "autumn-js";
import { eq } from "drizzle-orm";
import { buildAppUrl } from "../incident-route.js";
import { postSlackMessage } from "../infra/slack/api.js";
import { fetchSlackTargetsForOrg } from "../infra/slack/incident-messages.js";
import { logger } from "../logger.js";
import { type SpendLimitNotifierDeps, notifySpendLimit } from "./spend-limit-notifier.js";
import { renderSpendLimitEmail } from "./usage-email.js";
import { claimUsageThresholds, createResendSend } from "./usage-notifier-infra.js";

const log = logger.child({ scope: "billing.spend-limit" });

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:5173";
const AUTUMN_REQUEST_TIMEOUT_MS = 10_000;

type Env = Record<string, string | undefined>;

// Reached by the job and the incident flow alike, so both honour one switch.
export function spendLimitSecretKey(env: Env = process.env): string | null {
  const secretKey = env.AUTUMN_SECRET_KEY?.trim();
  return secretKey && env.BILLING_SPEND_LIMITS_ENABLED === "true" ? secretKey : null;
}

export function createSpendLimitBilling(secretKey: string): SpendLimitDeps {
  return createAutumnSpendLimitDeps(
    new Autumn({ secretKey, timeoutMs: AUTUMN_REQUEST_TIMEOUT_MS }),
  );
}

export function createSpendLimitNotifierDeps(env: Env = process.env): SpendLimitNotifierDeps {
  const resendKey = env.RESEND_API_KEY?.trim();
  const resendSend = resendKey ? createResendSend(resendKey, fetch) : null;
  return {
    claimSteps: (orgId, periodKey, steps) =>
      claimUsageThresholds(orgId, periodKey, steps, "spend_limit"),
    fetchMembers: (orgId) => fetchOrgMemberContacts(orgId),
    fetchOrgName: async (orgId) => {
      const rows = await db
        .select({ name: schema.orgs.name })
        .from(schema.orgs)
        .where(eq(schema.orgs.id, orgId))
        .limit(1);
      return rows[0]?.name ?? "Your organization";
    },
    sendEmail: async (email, notice) => {
      if (!resendSend) return;
      const { subject, html } = renderSpendLimitEmail(notice);
      await resendSend(email, subject, html);
    },
    postSlack: async (orgId, text) => {
      for (const target of await fetchSlackTargetsForOrg(orgId)) {
        await postSlackMessage({ target, text });
      }
    },
    manageBillingUrl: buildAppUrl(WEB_ORIGIN, "/settings?scope=org&section=billing"),
    now: () => new Date(),
  };
}

export async function defaultNotifySpendLimit(
  input: Parameters<typeof notifySpendLimit>[1],
): Promise<void> {
  await notifySpendLimit(createSpendLimitNotifierDeps(), input);
}

// Used only to word an already-blocked investigation, so any failure falls back
// to the generic out-of-credits explanation.
export async function isSpendLimitReached(orgId: string): Promise<boolean> {
  const secretKey = spendLimitSecretKey();
  if (!secretKey) return false;
  try {
    const row = await db.query.orgSpendLimits.findFirst({
      where: eq(schema.orgSpendLimits.orgId, orgId),
      columns: { monthlyLimitCents: true },
    });
    if (!row) return false;
    const state = await readSpendLimit(createSpendLimitBilling(secretKey), {
      orgId,
      limitCents: row.monthlyLimitCents,
    });
    return state.status === "reached";
  } catch (err) {
    log.warn(
      { orgId, err: err instanceof Error ? err.message : String(err) },
      "spend limit lookup failed",
    );
    return false;
  }
}
