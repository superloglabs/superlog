import assert from "node:assert/strict";
import { test } from "node:test";
import type { FeatureBalance } from "@superlog/billing";
import { formatCount, renderUsageEmail, usageRowsHtml } from "./usage-email.js";

function capped(featureId: string, usage: number, granted: number): FeatureBalance {
  return { featureId, usage, granted, overageAllowed: false, unlimited: false };
}

const balances = [
  capped("spans", 620_000, 1_000_000),
  capped("logs", 4_300_000, 5_000_000),
  capped("metric_points", 3_100_000, 10_000_000),
  capped("investigations", 3, 5),
];

test("formatCount is compact and email-friendly", () => {
  assert.equal(formatCount(4_300_000), "4.3M");
  assert.equal(formatCount(620_000), "620K");
  assert.equal(formatCount(1_000_000), "1M");
  assert.equal(formatCount(5_000_000), "5M");
  assert.equal(formatCount(5), "5");
  assert.equal(formatCount(0), "0");
});

test("usage rows: leader is cobalt, others muted, last row has no divider", () => {
  const html = usageRowsHtml(balances, "logs");
  // four rows
  assert.equal((html.match(/<tr><td style="padding:14px 18px;/g) || []).length, 4);
  // leader (logs, 86%) cobalt; spans muted
  assert.match(html, /color:#485ae2;font-weight:500;">86%/);
  assert.match(html, /color:#9c9fa6;font-weight:400;">62%/);
  // exactly three dividers (last row omits it)
  assert.equal((html.match(/border-bottom:1px solid #e6e6e8;/g) || []).length, 3);
  // formatted values
  assert.match(html, /4\.3M \/ 5M/);
  assert.match(html, /3 \/ 5/);
});

test("a feature at/over 100% is red", () => {
  const html = usageRowsHtml([capped("logs", 5_000_000, 5_000_000)], "logs");
  assert.match(html, /color:#d63840;font-weight:500;">100%/);
});

test("approaching variant: subject + headline + filled placeholders", () => {
  const { subject, html } = renderUsageEmail({
    orgName: "Acme",
    feature: "logs",
    pct: 86,
    threshold: 85,
    enforcement: false,
    manageBillingUrl: "https://superlog.sh/settings?scope=org&section=billing",
    balances,
  });
  assert.equal(subject, "You've used 86% of your Free plan logs");
  assert.match(html, /You're approaching your Free plan limit/);
  assert.match(html, /<strong>Acme<\/strong> has used 86%/);
  // no unfilled placeholders remain
  assert.doesNotMatch(html, /\{\{/);
});

test("limit-reached vs paused headlines depend on enforcement", () => {
  const base = {
    orgName: "Acme",
    feature: "logs",
    pct: 100,
    threshold: 100,
    manageBillingUrl: "https://x/billing",
    balances,
  };
  assert.match(
    renderUsageEmail({ ...base, enforcement: false }).html,
    /You've reached your Free plan limit/,
  );
  assert.match(renderUsageEmail({ ...base, enforcement: true }).html, /are paused/);
});

test("orgName is HTML-escaped in the body", () => {
  const { html } = renderUsageEmail({
    orgName: "A & <B>",
    feature: "spans",
    pct: 50,
    threshold: 50,
    enforcement: false,
    manageBillingUrl: "https://x/billing",
    balances,
  });
  assert.match(html, /A &amp; &lt;B&gt;/);
  assert.doesNotMatch(html, /A & <B>/);
});
