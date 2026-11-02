// Spend-limit notifier — PURE core, same split as usage-notifier.ts. Warns at 80%
// of a customer's monthly spend limit and again when it's reached. Delivery is
// best-effort: a failed notice must never fail the reconcile that enforces the
// limit. The claim ledger is the source of truth for "already notified".
import {
  type SpendLimitState,
  spendLimitNoticeSteps,
  spendLimitPeriodKey,
} from "@superlog/billing";
import { logger } from "../logger.js";

const log = logger.child({ scope: "billing.spend-limit" });

export type SpendLimitNotice = {
  orgName: string;
  billUsd: number;
  limitUsd: number;
  pct: number;
  reached: boolean;
  manageBillingUrl: string;
};

export type SpendLimitNotifierDeps = {
  // Atomically claims steps for (org, period); returns the ones this call won.
  claimSteps: (orgId: string, periodKey: string, steps: number[]) => Promise<number[]>;
  fetchMembers: (orgId: string) => Promise<Array<{ email: string }>>;
  fetchOrgName: (orgId: string) => Promise<string>;
  sendEmail: (email: string, notice: SpendLimitNotice) => Promise<void>;
  postSlack: (orgId: string, text: string) => Promise<void>;
  manageBillingUrl: string;
  now: () => Date;
};

export function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export function buildSpendLimitSlackText(notice: SpendLimitNotice): string {
  const link = `<${notice.manageBillingUrl}|Review your spend limit>`;
  const bill = `${formatUsd(notice.billUsd)} of its ${formatUsd(notice.limitUsd)}`;
  if (notice.reached) {
    return `:octagonal_sign: *${notice.orgName}* has reached its ${formatUsd(notice.limitUsd)} monthly spend limit — new telemetry beyond your included allowance is being dropped and billable investigations are paused until the next billing cycle. ${link} to resume sooner.`;
  }
  return `:chart_with_upwards_trend: *${notice.orgName}* has used ${notice.pct}% (${bill}) monthly spend limit. Ingest and investigations pause when it's reached. ${link}`;
}

export function buildSpendLimitIncidentSlackText(opts: { manageBillingUrl: string }): string {
  return `:octagonal_sign: Investigation not started — this organization has reached its monthly spend limit. <${opts.manageBillingUrl}|Review your spend limit> to resume.`;
}

export async function notifySpendLimit(
  deps: SpendLimitNotifierDeps,
  input: {
    orgId: string;
    limitCents: number;
    state: Extract<SpendLimitState, { status: "under" | "reached" }>;
  },
): Promise<void> {
  const { orgId, limitCents, state } = input;
  const steps = spendLimitNoticeSteps(state);
  if (steps.length === 0) return;

  const periodKey = spendLimitPeriodKey(state.resetsAt, limitCents, deps.now());
  const won = await deps.claimSteps(orgId, periodKey, steps);
  if (won.length === 0) return;

  const reached = state.status === "reached";
  // Claiming both steps at once means a jump to the limit sends only one notice,
  // and only when the limit itself was newly won.
  if (reached && !won.includes(100)) return;

  const notice: SpendLimitNotice = {
    orgName: await deps.fetchOrgName(orgId),
    billUsd: state.billUsd,
    limitUsd: state.limitUsd,
    pct: state.pct,
    reached,
    manageBillingUrl: deps.manageBillingUrl,
  };

  const members = await deps.fetchMembers(orgId);
  for (const member of members) {
    try {
      await deps.sendEmail(member.email, notice);
    } catch (err) {
      log.error(
        { orgId, err: err instanceof Error ? err.message : String(err) },
        "spend limit email failed",
      );
    }
  }
  try {
    await deps.postSlack(orgId, buildSpendLimitSlackText(notice));
  } catch (err) {
    log.error(
      { orgId, err: err instanceof Error ? err.message : String(err) },
      "spend limit slack post failed",
    );
  }
  log.info({ orgId, reached, pct: state.pct, members: members.length }, "spend limit notice sent");
}
