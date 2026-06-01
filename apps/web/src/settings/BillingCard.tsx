import { useAggregateEvents, useCustomer } from "autumn-js/react";
import { useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useCancelBilling } from "../api.ts";
import { Btn } from "../design/ui.tsx";

// Autumn plan ids → display names (must match autumn.config.ts / pricing.ts).
const PLAN_NAMES: Record<string, string> = {
  free: "Free",
  payg: "Pay as you go",
  pack_150: "Pro",
  pack_300: "Max",
};

// Plan tier order. Switching to a higher tier is an upgrade (applied now);
// switching to a lower paid tier (e.g. Pro/Max → PAYG) is a downgrade we
// schedule for the next cycle, so the org keeps what it prepaid until then.
const TIER_RANK: Record<string, number> = { free: 0, payg: 1, pack_150: 2, pack_300: 3 };

// Upgrade options shown when a Free org hits a cap (numbers mirror pricing.ts).
const PLAN_OPTIONS = [
  {
    id: "payg",
    name: "Pay as you go",
    price: "Usage-based",
    cta: "Switch to pay as you go",
    details: ["No caps — never paused", "$1.50 / investigation", "$0.50/M spans · logs · $0.15/M metrics"],
  },
  {
    id: "pack_150",
    name: "Pro",
    price: "$150/mo",
    cta: "Upgrade to Pro",
    details: ["120 investigation credits / mo", "then $1.25 / investigation", "Telemetry metered (PAYG rates)"],
  },
  {
    id: "pack_300",
    name: "Max",
    price: "$300/mo",
    cta: "Upgrade to Max",
    details: ["300 investigation credits / mo", "then $1.00 / investigation", "Telemetry metered (PAYG rates)"],
  },
  {
    id: "free",
    name: "Free",
    price: "$0",
    cta: "Switch to Free",
    details: ["5 investigations / mo", "1M spans · 5M logs · 10M metrics", "Hard caps — ingest pauses at limit"],
  },
];

function formatCount(n: number): string {
  if (n <= 0) return "0";
  if (n >= 1_000_000_000) return `${(n / 1e9).toFixed(n % 1e9 === 0 ? 0 : 1)}B`;
  if (n >= 1_000_000) return `${(n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}K`;
  return `${n}`;
}

function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

// Metered rates + plan base fees / per-credit overage (mirror pricing.ts). Used
// to estimate the current bill from this period's usage. Free is never billed
// (hard caps), so its bill is always $0.
const SIGNAL_RATE_PER_MILLION_USD: Record<string, number> = { spans: 0.5, logs: 0.5, metric_points: 0.15 };
const PLAN_BASE_USD: Record<string, number> = { free: 0, payg: 0, pack_150: 150, pack_300: 300 };
const CREDIT_OVERAGE_USD: Record<string, number> = { free: 0, payg: 1.5, pack_150: 1.25, pack_300: 1.0 };

export function BillingCard() {
  const { data: customer, isLoading, attach, openCustomerPortal, check, refetch } = useCustomer();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelBilling = useCancelBilling();
  // Usage time-series straight from Autumn (same source as the meters above), so
  // the graph and the meters always reconcile. customerId is inferred from the
  // Better Auth org session.
  const usage = useAggregateEvents({
    featureId: ["spans", "logs", "metric_points"],
    range: "1bc", // current billing cycle — matches the meters above
    binSize: "day",
  });
  const usageSeries = (usage.list ?? []).map((p) => ({
    date: new Date(p.period).toISOString().slice(0, 10),
    spans: p.values?.spans ?? 0,
    logs: p.values?.logs ?? 0,
    metric_points: p.values?.metric_points ?? 0,
  }));

  if (isLoading) {
    return <p className="text-[13.5px] text-muted">Loading billing…</p>;
  }
  if (!customer) {
    return (
      <p className="text-[13.5px] text-muted">
        Billing isn’t set up for this workspace yet. Once it is, your plan and usage will show here.
      </p>
    );
  }

  const activeSub = customer.subscriptions?.find((s) => s.status === "active");
  const planId = activeSub?.planId ?? "free";
  const planName = PLAN_NAMES[planId] ?? planId;

  // A scheduled downgrade (e.g. Pro → PAYG) shows up as a second subscription
  // with status "scheduled" that takes effect at the end of the current cycle.
  const scheduledSub = customer.subscriptions?.find((s) => s.status === "scheduled");
  const scheduledName = scheduledSub ? (PLAN_NAMES[scheduledSub.planId] ?? scheduledSub.planId) : null;
  const scheduledAtMs = scheduledSub?.startedAt ?? activeSub?.currentPeriodEnd ?? null;

  const balanceOf = (featureId: string) => check({ featureId }).balance;

  // True when any hard-capped signal (Free tier) is exhausted — ingest/usage is
  // paused, so we surface the upgrade CTA.
  const atLimit = ["investigations", "spans", "logs", "metric_points"].some((f) => {
    const b = balanceOf(f);
    return !!b && !b.unlimited && b.granted > 0 && !b.overageAllowed && b.usage >= b.granted;
  });

  // Estimated current bill: plan base fee + this period's metered usage beyond
  // what the plan includes (granted). On paid plans telemetry has granted 0 (all
  // metered); credits are billed beyond the plan's included credits. Free has no
  // overage price, so it's always $0.
  const billableBeyond = (featureId: string) => {
    const b = balanceOf(featureId);
    if (!b || b.unlimited) return 0;
    return Math.max(0, b.usage - b.granted);
  };
  const currentBillUsd =
    planId === "free"
      ? 0
      : (PLAN_BASE_USD[planId] ?? 0) +
        (["spans", "logs", "metric_points"] as const).reduce(
          (sum, s) => sum + (billableBeyond(s) / 1_000_000) * (SIGNAL_RATE_PER_MILLION_USD[s] ?? 0),
          0,
        ) +
        billableBeyond("investigations") * (CREDIT_OVERAGE_USD[planId] ?? 0);

  const onAttach = async (target: string) => {
    setBusy(target);
    setError(null);
    try {
      if (target === "free") {
        // "Stop paying now": revert to Free immediately, carrying usage over so a
        // maxed cap can't be reset by toggling (see /api/me/billing/cancel).
        await cancelBilling.mutateAsync();
      } else if ((TIER_RANK[target] ?? 0) < (TIER_RANK[planId] ?? 0)) {
        // Downgrade between paid plans (e.g. Pro/Max → PAYG): schedule for the end
        // of the current cycle so the org keeps the credits it prepaid until then.
        // Usage resets naturally at the cycle boundary, so no carry-over needed.
        await attach({ planId: target, planSchedule: "end_of_cycle" });
      } else {
        // Upgrade: apply now, carrying usage over (continuous metering closes the
        // toggle-reset loophole; the carried free-tier usage sits inside the new
        // plan's included allowance, so it isn't billed).
        await attach({ planId: target, planSchedule: "immediate", carryOverUsages: { enabled: true } });
      }
      await refetch(); // reflect the new plan / scheduled change immediately
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn’t change plan — please try again.");
    } finally {
      setBusy(null);
    }
  };

  const onPortal = async () => {
    setBusy("portal");
    try {
      const res = await openCustomerPortal();
      if (res?.url) window.location.href = res.url;
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Current plan */}
      <div className="rounded-lg border border-border bg-surface/30 p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-[11px] tracking-wide text-subtle">Current plan</div>
            <div className="mt-1 text-[18px] font-semibold tracking-tight text-fg">{planName}</div>
          </div>
          {customer.stripeId && (
            <Btn variant="secondary" size="sm" disabled={busy !== null} onClick={onPortal}>
              {busy === "portal" ? "Opening…" : "Manage billing"}
            </Btn>
          )}
        </div>
        {scheduledName && (
          <div className="mt-3 border-t border-border pt-3 text-[12.5px] leading-relaxed text-muted">
            Scheduled: switching to <span className="font-medium text-fg">{scheduledName}</span>
            {scheduledAtMs ? ` on ${new Date(scheduledAtMs).toLocaleDateString()}` : " next cycle"}. You
            keep {planName} until then.
          </div>
        )}
        {atLimit && (
          <div className="mt-3 border-t border-border pt-3 text-[12.5px] leading-relaxed text-fg">
            <span className="font-semibold">You’ve reached your Free plan limits.</span> Ingest is
            paused for capped signals. Switch to pay-as-you-go (no caps) or pick a pack to resume —
            you’ll add a card at checkout.
          </div>
        )}
      </div>

      {/* Upgrade options — emphasised once a Free cap is hit */}
      <div className="space-y-3">
        <div className="text-[11px] tracking-wide text-subtle">
          {atLimit ? "Choose a plan to resume" : "Change plan"}
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          {PLAN_OPTIONS.filter((o) => o.id !== planId).map((o) => (
            <PlanOption
              key={o.id}
              option={o}
              busy={busy}
              highlight={atLimit && o.id === "payg"}
              onAttach={onAttach}
            />
          ))}
        </div>
        {error && <p className="text-[12px] text-danger">{error}</p>}
      </div>

      {/* Usage this period — one card with all meters + the running bill */}
      <div className="rounded-lg border border-border bg-surface/30 p-4">
        <div className="mb-3 text-[11px] tracking-wide text-subtle">This period</div>
        <div className="grid gap-2">
          <UsageMeter label="Investigation credits" balance={balanceOf("investigations")} format={(n) => n.toLocaleString()} />
          <UsageMeter label="Spans" balance={balanceOf("spans")} format={formatCount} />
          <UsageMeter label="Logs" balance={balanceOf("logs")} format={formatCount} />
          <UsageMeter label="Metric points" balance={balanceOf("metric_points")} format={formatCount} />
        </div>
        <div className="mt-3 flex items-baseline justify-between border-t border-border pt-3">
          <div>
            <div className="text-[13px] font-medium text-fg">Current bill</div>
            <div className="text-[11px] text-muted">Plan fee + metered usage so far this period (estimate)</div>
          </div>
          <div className="text-[16px] font-semibold tabular-nums text-fg">{formatUsd(currentBillUsd)}</div>
        </div>
      </div>

      {/* Usage over time */}
      <BillingUsageChart series={usageSeries} loading={usage.isLoading} />

      <p className="text-[12.5px] text-muted">
        Questions? Send us a line at{" "}
        <a
          href="mailto:ash@superlog.sh"
          className="text-fg underline underline-offset-2 hover:text-accent"
        >
          ash@superlog.sh
        </a>
      </p>
    </div>
  );
}

type Balance = ReturnType<ReturnType<typeof useCustomer>["check"]>["balance"];

// Renders the meter differently depending on whether the feature is hard-capped
// or metered:
//   • Free tier (overageAllowed false): granted is a hard cap → progress bar,
//     red + "limit reached" once exhausted (ingest pauses).
//   • Paid plan (overageAllowed true): granted is the INCLUDED free allowance,
//     and usage beyond it is billed, not blocked → accent bar, "X included
//     · +Y billed", never red.
//   • Pure-metered with no allowance (granted 0): just "X used".
//   • Unlimited: "Unlimited".
function UsageMeter({
  label,
  balance,
  format,
}: {
  label: string;
  balance: Balance;
  format: (n: number) => string;
}) {
  if (!balance) return <Row label={label} detail="—" />;
  if (balance.unlimited) return <Row label={label} detail="Unlimited" />;
  if (balance.granted <= 0) return <Row label={label} detail={`${format(balance.usage)} used`} />;

  // Paid plan: metered, no ceiling — show plain usage, NO progress bar (a bar
  // would imply a limit that doesn't exist). granted is the included allowance.
  if (balance.overageAllowed) {
    const over = Math.max(0, balance.usage - balance.granted);
    return (
      <div className="flex items-baseline justify-between gap-3 py-1">
        <span className="text-[13px] text-fg">{label}</span>
        <div className="text-right">
          <div className="text-[12.5px] font-medium tabular-nums text-fg">{format(balance.usage)} used</div>
          <div className="text-[11px] tabular-nums text-subtle">
            {format(balance.granted)} included{over > 0 ? ` · +${format(over)} billed` : ""}
          </div>
        </div>
      </div>
    );
  }

  // Free tier: granted is a hard cap → progress bar, red + "limit reached" once full.
  const pct = Math.max(0, Math.min(100, Math.round((balance.usage / balance.granted) * 100)));
  return (
    <div className="py-1">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] text-fg">{label}</span>
        <span className="text-[12.5px] font-medium tabular-nums text-muted">{pct}%</span>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-border">
        <div
          className={`h-full rounded-full ${pct >= 100 ? "bg-danger" : "bg-accent"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-1.5 text-[11.5px] tabular-nums text-subtle">
        {format(balance.usage)} of {format(balance.granted)}
        {pct >= 100 ? " · limit reached" : ""}
      </div>
    </div>
  );
}

function Row({ label, detail }: { label: string; detail: string }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-[13px] text-fg">{label}</span>
      <span className="text-[12.5px] font-medium tabular-nums text-muted">{detail}</span>
    </div>
  );
}

function PlanOption({
  option,
  busy,
  highlight,
  onAttach,
}: {
  option: (typeof PLAN_OPTIONS)[number];
  busy: string | null;
  highlight: boolean;
  onAttach: (planId: string) => void;
}) {
  return (
    <div
      className={`flex flex-col rounded-lg border p-3 ${
        highlight ? "border-border-strong bg-surface/60" : "border-border bg-bg/35"
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[14px] font-semibold tracking-tight text-fg">{option.name}</span>
        <span className="text-[12px] font-medium text-muted">{option.price}</span>
      </div>
      <ul className="mt-2 flex-1 space-y-1 text-[11.5px] leading-relaxed text-muted">
        {option.details.map((d) => (
          <li key={d} className="flex items-baseline gap-1.5">
            <span className="text-subtle">•</span>
            <span>{d}</span>
          </li>
        ))}
      </ul>
      <Btn
        variant={highlight ? "primary" : "secondary"}
        size="sm"
        className="mt-3 w-full justify-center"
        disabled={busy !== null}
        onClick={() => onAttach(option.id)}
      >
        {busy === option.id ? "Loading…" : option.cta}
      </Btn>
    </div>
  );
}

type UsagePoint = { date: string; spans: number; logs: number; metric_points: number };

// Daily usage from Autumn (stacked: spans / logs / metric points), scoped to the
// current billing cycle so it lines up with the meters above.
function BillingUsageChart({ series, loading }: { series: UsagePoint[]; loading: boolean }) {
  const hasData = series.some((d) => d.spans + d.logs + d.metric_points > 0);
  return (
    <div>
      <div className="mb-2 text-[11px] tracking-wide text-subtle">Usage · this billing cycle</div>
      {loading ? (
        <p className="text-[12.5px] text-muted">Loading usage…</p>
      ) : !hasData ? (
        <p className="text-[12.5px] text-muted">No usage yet this billing cycle.</p>
      ) : (
        <div className="h-44 w-full rounded-lg border border-border bg-bg/35 p-2">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={series} margin={{ top: 6, right: 8, bottom: 0, left: -8 }}>
              <CartesianGrid strokeOpacity={0.08} vertical={false} />
              <XAxis
                dataKey="date"
                tickFormatter={(d) => String(d).slice(5)}
                tick={{ fontSize: 10, fill: "var(--color-subtle)" }}
                axisLine={false}
                tickLine={false}
                minTickGap={20}
              />
              <YAxis
                tick={{ fontSize: 10, fill: "var(--color-subtle)" }}
                axisLine={false}
                tickLine={false}
                width={40}
                tickFormatter={(v) => formatCount(Number(v))}
              />
              <Tooltip
                formatter={(v, name) => [formatCount(Number(v)), name]}
                labelStyle={{ color: "var(--color-fg)" }}
                contentStyle={{
                  background: "var(--color-surface)",
                  border: "1px solid var(--color-border)",
                  borderRadius: 6,
                  fontSize: 12,
                }}
              />
              <Area type="monotone" dataKey="spans" name="Spans" stackId="u" stroke="var(--color-accent)" fill="var(--color-accent)" fillOpacity={0.22} />
              <Area type="monotone" dataKey="logs" name="Logs" stackId="u" stroke="var(--color-success)" fill="var(--color-success)" fillOpacity={0.22} />
              <Area type="monotone" dataKey="metric_points" name="Metric points" stackId="u" stroke="var(--color-warning)" fill="var(--color-warning)" fillOpacity={0.22} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
