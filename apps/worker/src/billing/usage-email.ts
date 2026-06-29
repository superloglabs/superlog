// Pure renderer for the usage-limit notification email: fills the generated MJML
// shell (usage-email-shell.generated.ts) with the org's usage table and the
// variant-specific copy. No I/O — unit-tested in usage-email.test.ts. The Resend
// send itself lives in usage-notifier-ticker.ts.
import type { FeatureBalance } from "@superlog/billing";
import { USAGE_EMAIL_SHELL } from "./usage-email-shell.generated.js";
import { USAGE_FEATURE_IDS, featureLabel } from "./usage-notifier.js";

const COBALT = "#485ae2";
const RED = "#d63840";
const MUTED = "#9c9fa6";

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// 4_300_000 → "4.3M", 620_000 → "620K", 5 → "5". Compact, e-mail-friendly.
export function formatCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  const trim = (v: number) => v.toFixed(1).replace(/\.0$/, "");
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trim(n / 1_000)}K`;
  return String(Math.round(n));
}

function pctOf(b: FeatureBalance): number {
  return b.granted > 0 ? Math.floor((b.usage / b.granted) * 100) : 0;
}

// Per-feature percentage color: red at/over the cap, cobalt for the feature that
// triggered this notification (the watermark leader), muted otherwise.
function pctColor(featureId: string, pct: number, leadFeature: string): string {
  if (pct >= 100) return RED;
  if (featureId === leadFeature) return COBALT;
  return MUTED;
}

// The four usage rows (fixed order), as <tr> HTML injected into the shell's card
// table. Last row drops the divider.
export function usageRowsHtml(balances: FeatureBalance[], leadFeature: string): string {
  const byId = new Map(balances.map((b) => [b.featureId, b]));
  const rows = USAGE_FEATURE_IDS.map((id) => byId.get(id)).filter(
    (b): b is FeatureBalance => b !== undefined,
  );
  return rows
    .map((b, i) => {
      const pct = pctOf(b);
      const border = i < rows.length - 1 ? "border-bottom:1px solid #e6e6e8;" : "";
      const color = pctColor(b.featureId, pct, leadFeature);
      const weight = color === MUTED ? "400" : "500";
      const value = esc(`${formatCount(b.usage)} / ${formatCount(b.granted)}`);
      const cell = "font-family:'Inter';font-size:15px;";
      return `<tr><td style="padding:14px 18px;${border}"><table width="100%" role="presentation"><tr><td style="${cell}color:#232326;">${esc(featureLabel(b.featureId))}</td><td style="${cell}text-align:right;color:#18181b;font-weight:500;">${value}&nbsp;&nbsp;<span style="color:${color};font-weight:${weight};">${pct}%</span></td></tr></table></td></tr>`;
    })
    .join("");
}

export type UsageEmailInput = {
  orgName: string;
  feature: string; // watermark leader feature id
  pct: number; // watermark percentage
  threshold: number; // 50 | 85 | 100
  enforcement: boolean;
  manageBillingUrl: string;
  balances: FeatureBalance[];
};

type VariantCopy = {
  subject: string;
  headline: string;
  intro: string; // HTML (orgName already escaped)
  ctaCopy: string;
};

function variantCopy(input: UsageEmailInput): VariantCopy {
  const org = esc(input.orgName);
  const label = featureLabel(input.feature);
  if (input.threshold < 100) {
    return {
      subject: `You've used ${input.pct}% of your Free plan ${label}`,
      headline: "You're approaching your Free plan limit",
      intro: `<strong>${org}</strong> has used ${input.pct}% of its monthly Free plan ${label} so far this cycle. You'll keep sending data and running investigations until you reach the limit, then they pause until your next cycle.`,
      ctaCopy:
        "Pay-as-you-go and the Pro and Max packs raise your limits and add investigation credits.",
    };
  }
  if (!input.enforcement) {
    return {
      subject: `${input.orgName} has reached its Free plan ${label} limit`,
      headline: "You've reached your Free plan limit",
      intro: `<strong>${org}</strong> has reached its monthly Free plan ${label} limit. Upgrade to keep telemetry and automated investigations running without interruption.`,
      ctaCopy:
        "Switching to pay-as-you-go or a Pro or Max pack restores ingest and investigations and lifts your monthly limits.",
    };
  }
  return {
    subject: `${input.orgName}: ingest and investigations are paused`,
    headline: "Your ingest and investigations are paused",
    intro: `<strong>${org}</strong> has hit its monthly Free plan limit, so new telemetry and automated investigations are paused until your usage resets next cycle. Upgrade to resume right away.`,
    ctaCopy:
      "Switching to pay-as-you-go or a Pro or Max pack restores ingest and investigations immediately and lifts your monthly limits.",
  };
}

export function renderUsageEmail(input: UsageEmailInput): { subject: string; html: string } {
  const copy = variantCopy(input);
  const html = USAGE_EMAIL_SHELL.replace("{{headline}}", esc(copy.headline))
    .replace("{{intro}}", copy.intro)
    .replace("{{usageRows}}", usageRowsHtml(input.balances, input.feature))
    .replace("{{ctaCopy}}", esc(copy.ctaCopy))
    .replace("{{ctaLabel}}", "Upgrade")
    .replace("{{ctaUrl}}", esc(input.manageBillingUrl));
  return { subject: copy.subject, html };
}
