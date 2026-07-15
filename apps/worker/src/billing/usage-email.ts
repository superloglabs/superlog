// Renderer for the usage-limit notification email. The shell is intentionally
// plain checked-in HTML: compiling a static MJML file at runtime brought a large
// parser/minifier dependency tree into the worker and exposed file-include code
// that the product never needs. The Resend send lives in usage-notifier-infra.ts.
import type { FeatureBalance } from "@superlog/billing";
import { USAGE_FEATURE_IDS, featureLabel } from "./usage-notifier.js";

const COBALT = "#485ae2";
const RED = "#d63840";
const MUTED = "#9c9fa6";

const EMAIL_SHELL = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Your Superlog plan usage</title>
</head>
<body style="margin:0;background:#fff;color:#232326;font-family:'Inter Display',Inter,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#fff;border-collapse:collapse;">
    <tr><td align="center" style="padding:28px 16px 32px;">
      <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:600px;border-collapse:collapse;">
        <tr><td style="padding:0 0 26px;"><img src="https://images.vialoops.com/cmowh1ofc04l30i53nid5hp2v/cmqz06roj2wy30j1a8ze0gr60.png" alt="superlog" width="150" style="display:block;border:0;width:150px;max-width:100%;"></td></tr>
        <tr><td style="padding:0 0 10px;color:#18181b;font-size:23px;font-weight:600;line-height:30px;letter-spacing:-.02em;">{{headline}}</td></tr>
        <tr><td style="padding:0 0 26px;color:#5b5e66;font-size:15px;line-height:23px;">{{intro}}</td></tr>
        <tr><td style="padding:0 0 8px;color:#5b5e66;font-size:13px;line-height:20px;">Usage this cycle</td></tr>
        <tr><td><table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#f3f3f4;border-radius:14px;border-collapse:separate;">{{usageRows}}</table></td></tr>
        <tr><td style="padding:33px 0 42px;"><table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:collapse;"><tr>
          <td valign="middle" style="vertical-align:middle;font-size:15px;color:#5b5e66;line-height:22px;padding-right:18px;">{{ctaCopy}}</td>
          <td valign="middle" style="vertical-align:middle;text-align:right;white-space:nowrap;"><a href="{{ctaUrl}}" style="display:inline-block;background:#485ae2;color:#fff;font-size:16px;font-weight:500;text-decoration:none;padding:6px 11px;border-radius:8px;"><span style="font-size:16px;vertical-align:-1px;">&#8593;</span>&nbsp;{{ctaLabel}}</a></td>
        </tr></table></td></tr>
        <tr><td style="font-size:12px;color:#9c9fa6;line-height:18px;">You're getting this because your Superlog organization is on the Free plan. Manage your plan anytime in organization billing settings.</td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

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
  const html = EMAIL_SHELL.replace("{{headline}}", esc(copy.headline))
    .replace("{{intro}}", copy.intro)
    .replace("{{usageRows}}", usageRowsHtml(input.balances, input.feature))
    .replace("{{ctaCopy}}", esc(copy.ctaCopy))
    .replace("{{ctaLabel}}", "Upgrade")
    .replace("{{ctaUrl}}", esc(input.manageBillingUrl));
  return { subject: copy.subject, html };
}
