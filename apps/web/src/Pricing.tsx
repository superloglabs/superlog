import { usePostHog } from "posthog-js/react";
import { useEffect, useState } from "react";
import { AuthForm } from "./AuthForm.tsx";
import { Btn, Label, Tile } from "./design/ui.tsx";
import { TopNav } from "./Landing.tsx";

type AuthMode = "sign-in" | "sign-up" | null;

// Pay-as-you-go unit prices. Source of truth: packages/billing/src/pricing.ts —
// keep in sync if those change.
const PAYG = {
  investigationUsd: 1.5,
  spansPerMillionUsd: 0.5,
  logsPerMillionUsd: 0.5,
  metricPointsPerMillionUsd: 0.15,
  includedInvestigations: 50,
  promotionalInvestigations: 100,
  includedSpans: 1_000_000,
  includedLogs: 5_000_000,
  includedMetricPoints: 10_000_000,
};

const FREE_INCLUDED = [
  "1M spans",
  "5M logs",
  "10M metric points",
  "30-day retention",
  "50 incidents investigated / month",
];

const included = [
  ["OTel-first install", "Agent-generated PRs wire your services into vendor-neutral telemetry."],
  ["Incident control plane", "Similar errors become one clear incident with severity and impact."],
  [
    "Investigations as credits",
    "Each completed investigation is one credit; Free and PAYG each include 50 every month.",
  ],
  [
    "Metered telemetry",
    "Spans, logs, and metric points are billed per signal — cheaper than per-GB, metadata-neutral.",
  ],
];

export function Pricing() {
  const [authMode, setAuthMode] = useState<AuthMode>(null);

  // Read the hash after mount so SSR and the initial hydration render agree
  // (both null). Moving this to useEffect prevents the text-mismatch hydration
  // error that fires when SSO/verify callbacks redirect to /pricing#sso-callback.
  useEffect(() => {
    const h = window.location.hash;
    if (h.includes("sso-callback") || h.includes("verify")) setAuthMode("sign-in");
  }, []);

  const posthog = usePostHog();
  const openSignIn = () => {
    posthog?.capture("sign_in_clicked", { surface: "pricing" });
    setAuthMode("sign-in");
  };
  const openSignUp = () => {
    posthog?.capture("sign_up_clicked", { surface: "pricing" });
    setAuthMode("sign-up");
  };

  return (
    <div className="relative min-h-screen bg-bg font-sans text-fg">
      <TopNav onSignIn={openSignIn} onSignUp={openSignUp} />

      <main>
        <section className="px-6 pb-8 pt-20 text-center md:px-8 md:pt-24 xl:px-12">
          <h1
            className="text-[2.4375rem] leading-[0.98] tracking-tight text-fg md:text-[4.3125rem] lg:text-[57px]"
            style={{ fontWeight: 450 }}
          >
            Pricing
          </h1>
        </section>

        <div className="mx-auto w-full max-w-[1400px] px-6 pb-24 md:px-8 xl:px-12">
          <FreeRow onSignUp={openSignUp} />
          <PaygEstimator onSignUp={openSignUp} />

          <section className="mt-24 grid scroll-mt-24 grid-cols-1 gap-6 lg:grid-cols-2">
            <header className="flex max-w-3xl flex-col justify-center lg:max-w-none">
              <h2 className="text-[28px] font-semibold tracking-tight text-fg md:text-[32px] lg:text-[36px] lg:leading-none">
                Included in every workspace.
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-muted lg:mt-6 lg:text-[16px] lg:leading-relaxed">
                You pay for telemetry you send and investigations you run — nothing else. The
                plumbing, incident intelligence, and agent workflows come together as one system.
              </p>
            </header>

            <div className="grid gap-3">
              {included.map(([title, body]) => (
                <Tile key={title} className="bg-surface/30">
                  <div className="flex items-start gap-3">
                    <span className="mt-1 h-1.5 w-1.5 shrink-0 bg-accent" />
                    <div>
                      <h3 className="text-[15px] font-semibold tracking-tight text-fg">{title}</h3>
                      <p className="mt-1 text-[12.5px] leading-relaxed text-muted">{body}</p>
                    </div>
                  </div>
                </Tile>
              ))}
            </div>
          </section>

          <section className="mt-24 border border-border p-10 text-center md:p-16">
            <Label>ready when you are</Label>
            <h2
              className="mx-auto mt-4 max-w-2xl text-balance text-[2rem] leading-[1.05] tracking-tight text-fg md:text-[2.75rem]"
              style={{ fontWeight: 450 }}
            >
              Start free.
            </h2>
            <div className="mt-8 flex flex-wrap justify-center gap-3">
              <Btn size="lg" onClick={openSignUp}>
                Get started
              </Btn>
            </div>
          </section>

          <PricingFooter />
        </div>
      </main>

      {authMode && <AuthModal mode={authMode} onClose={() => setAuthMode(null)} />}
    </div>
  );
}

function FreeRow({ onSignUp }: { onSignUp: () => void }) {
  return (
    <Tile className="mt-8 rounded-lg bg-surface/30">
      {/* Same column grid as the pay-as-you-go card below (1fr + 240px) so the
          left content and the price/CTA panel line up across both cards. */}
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_240px]">
        {/* Left — plan name + description + what's included */}
        <div>
          <h2 className="text-[27px] font-semibold tracking-tight text-fg">Free</h2>
          <p className="mt-2 max-w-md text-[13.5px] leading-relaxed text-muted">
            For side projects and first installs — useful telemetry and 50 investigations every
            month, free.
          </p>
          <ul className="mt-6 flex flex-col gap-2 text-[13.5px] leading-relaxed text-fg">
            {FREE_INCLUDED.map((feature) => (
              <li key={feature} className="flex items-baseline gap-2.5">
                <span className="text-muted">•</span>
                <span>{feature}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* Right — price + CTA, mirroring the estimator's 240px panel */}
        <div className="flex flex-col justify-center border-border lg:border-l lg:pl-8">
          <div className="flex items-end gap-2">
            <span className="text-[44px] font-semibold leading-none tracking-tight text-fg">
              $0
            </span>
            <span className="pb-1.5 text-[13px] font-medium text-muted">forever</span>
          </div>
          <Btn size="lg" className="mt-6 w-full justify-center" onClick={onSignUp}>
            Start free
          </Btn>
        </div>
      </div>
    </Tile>
  );
}

function formatCount(n: number): string {
  if (n <= 0) return "0";
  if (n >= 1_000_000_000) return `${(n / 1e9).toFixed(n % 1e9 === 0 ? 0 : 1)}B`;
  if (n >= 1_000_000) return `${(n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}K`;
  return `${n}`;
}

// Telemetry sliders are anchored: the track is split into equal
// segments between the tick values, so small volumes get as much room as large
// ones (fine control at the low end) while the slider still reaches high totals.
const TELEMETRY_ANCHORS = [0, 1_000_000, 10_000_000, 50_000_000, 250_000_000];
const INVESTIGATION_ANCHORS = [0, 25, 75, 150, 300];

// Round to a granularity that scales with magnitude (≈1k notches at the low end,
// coarser higher up) so the readout stays clean.
function niceRound(v: number): number {
  if (v <= 0) return 0;
  if (v < 1_000) return Math.round(v);
  if (v < 1_000_000) return Math.round(v / 1_000) * 1_000;
  if (v < 10_000_000) return Math.round(v / 10_000) * 10_000;
  if (v < 100_000_000) return Math.round(v / 100_000) * 100_000;
  return Math.round(v / 1_000_000) * 1_000_000;
}

function ScaleSlider(props: {
  label: string;
  anchors: number[];
  value: number;
  lineUsd: number;
  formatValue: (n: number) => string;
  formatTick: (n: number) => string;
  onChange: (v: number) => void;
}) {
  const SEG = 1000;
  const posMax = (props.anchors.length - 1) * SEG;

  const toPos = (val: number): number => {
    const a = props.anchors;
    for (let i = 0; i < a.length - 1; i++) {
      const lo = a[i] ?? 0;
      const hi = a[i + 1] ?? lo;
      if (val <= hi) {
        const frac = hi === lo ? 0 : (val - lo) / (hi - lo);
        return Math.round((i + Math.max(0, Math.min(1, frac))) * SEG);
      }
    }
    return posMax;
  };
  const fromPos = (pos: number): number => {
    const a = props.anchors;
    const i = Math.min(Math.floor(pos / SEG), a.length - 2);
    const lo = a[i] ?? 0;
    const hi = a[i + 1] ?? lo;
    return niceRound(lo + ((pos - i * SEG) / SEG) * (hi - lo));
  };

  const pos = toPos(props.value);
  const pct = posMax === 0 ? 0 : (pos / posMax) * 100;

  return (
    <div className="border-b border-border py-3 last:border-0">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] font-medium text-fg">{props.label}</span>
        <span className="text-[12.5px] font-medium text-muted">${props.lineUsd.toFixed(2)}/mo</span>
      </div>
      <div className="mt-2 flex items-center gap-3">
        <input
          type="range"
          // The input is as tall as the thumb (16px) and the track is a 6px bar
          // drawn centered via the background, so the thumb centers naturally
          // (no fragile negative margins). Chrome reads the gradient background;
          // Firefox uses its native ::-moz-range-progress / -track pseudo-elements.
          style={{
            background: `linear-gradient(to right, var(--color-accent) ${pct}%, var(--color-border) ${pct}%) center / 100% 6px no-repeat`,
          }}
          className="h-4 w-full cursor-pointer appearance-none bg-transparent focus:outline-none focus-visible:outline-none [&::-moz-range-progress]:h-1.5 [&::-moz-range-progress]:rounded-full [&::-moz-range-progress]:bg-accent [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-fg [&::-moz-range-track]:h-1.5 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:border-0 [&::-moz-range-track]:bg-border [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-0 [&::-webkit-slider-thumb]:bg-fg"
          min={0}
          max={posMax}
          step={1}
          value={pos}
          onChange={(e) => props.onChange(fromPos(Number(e.target.value)))}
          aria-label={props.label}
        />
        <span className="w-[88px] shrink-0 text-right text-[13px] font-semibold tabular-nums text-fg">
          {props.formatValue(props.value)}
        </span>
      </div>
      {/* Pad right by the value readout (w-[88px]) + the row's gap-3 (12px) so the
          tick labels line up with the slider track instead of the full card width.
          Without this the track is ~100px narrower than the ticks and they drift
          apart — most visibly on a narrow (mobile) card. */}
      <div className="mt-1 flex justify-between pr-[100px] text-[11px] text-subtle">
        {props.anchors.map((a) => (
          <span key={a}>{props.formatTick(a)}</span>
        ))}
      </div>
    </div>
  );
}

function PaygEstimator({ onSignUp }: { onSignUp: () => void }) {
  const [investigations, setInvestigations] = useState(25);
  const [spans, setSpans] = useState(2_000_000);
  const [logs, setLogs] = useState(5_000_000);
  const [metrics, setMetrics] = useState(20_000_000);

  const billableInvestigations = Math.max(
    0,
    investigations - PAYG.includedInvestigations - PAYG.promotionalInvestigations,
  );
  const spansUsd = (Math.max(0, spans - PAYG.includedSpans) / 1_000_000) * PAYG.spansPerMillionUsd;
  const logsUsd = (Math.max(0, logs - PAYG.includedLogs) / 1_000_000) * PAYG.logsPerMillionUsd;
  const metricsUsd =
    (Math.max(0, metrics - PAYG.includedMetricPoints) / 1_000_000) * PAYG.metricPointsPerMillionUsd;
  const investigationUsd = billableInvestigations * PAYG.investigationUsd;
  const total = investigationUsd + spansUsd + logsUsd + metricsUsd;

  return (
    <Tile className="mt-6 rounded-lg bg-surface/30">
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_240px]">
        <div>
          <h2 className="text-[27px] font-semibold tracking-tight text-fg">Pay as you go</h2>
          <p className="mt-2 text-[13.5px] leading-relaxed text-muted">
            Switch with a one-time grant of 100 promotional investigations, plus 50 included every
            month. No base fee, no commitment.
          </p>
          <div className="mt-7">
            <ScaleSlider
              label="Investigations"
              anchors={INVESTIGATION_ANCHORS}
              value={investigations}
              lineUsd={investigationUsd}
              formatValue={(n) => `${n} / mo`}
              formatTick={(n) => `${n}`}
              onChange={setInvestigations}
            />
            <ScaleSlider
              label="Spans"
              anchors={TELEMETRY_ANCHORS}
              value={spans}
              lineUsd={spansUsd}
              formatValue={(n) => n.toLocaleString("en-US")}
              formatTick={formatCount}
              onChange={setSpans}
            />
            <ScaleSlider
              label="Logs"
              anchors={TELEMETRY_ANCHORS}
              value={logs}
              lineUsd={logsUsd}
              formatValue={(n) => n.toLocaleString("en-US")}
              formatTick={formatCount}
              onChange={setLogs}
            />
            <ScaleSlider
              label="Metric points"
              anchors={TELEMETRY_ANCHORS}
              value={metrics}
              lineUsd={metricsUsd}
              formatValue={(n) => n.toLocaleString("en-US")}
              formatTick={formatCount}
              onChange={setMetrics}
            />
          </div>
        </div>
        <div className="flex flex-col justify-center border-border lg:border-l lg:pl-8">
          <Label>estimated with one-time promotion</Label>
          <div className="mt-3 flex items-end gap-2">
            <span className="text-[44px] font-semibold leading-none tracking-tight text-fg">
              ${total.toFixed(2)}
            </span>
            <span className="pb-1.5 text-[13px] font-medium text-muted">/ month</span>
          </div>
          <p className="mt-3 text-[12.5px] leading-relaxed text-muted">
            Usage beyond your included and promotional investigations is $1.50 each. Telemetry
            overages are $0.50 / M spans and logs, and $0.15 / M metric points.
          </p>
          <Btn size="lg" className="mt-6 w-full justify-center" onClick={onSignUp}>
            Get started
          </Btn>
        </div>
      </div>
    </Tile>
  );
}

function PricingFooter() {
  return (
    <footer className="mt-16 bg-bg py-14 md:py-16">
      <div className="grid gap-10 md:grid-cols-[180px_180px] md:justify-end">
        <div>
          <h3 className="text-[13px] font-semibold text-subtle">Product</h3>
          <div className="mt-5">
            <div className="flex flex-col gap-3">
              <a
                href="/pricing"
                className="text-[14px] font-medium text-muted transition-colors hover:text-fg"
              >
                Pricing
              </a>
              <a
                href="/blog"
                className="text-[14px] font-medium text-muted transition-colors hover:text-fg"
              >
                Blog
              </a>
              <a
                href="/changelog"
                className="text-[14px] font-medium text-muted transition-colors hover:text-fg"
              >
                Changelog
              </a>
              <a
                href="/roadmap"
                className="text-[14px] font-medium text-muted transition-colors hover:text-fg"
              >
                Roadmap
              </a>
              <a
                href="/team"
                className="text-[14px] font-medium text-muted transition-colors hover:text-fg"
              >
                Team
              </a>
              <a
                href="/tos"
                className="text-[14px] font-medium text-muted transition-colors hover:text-fg"
              >
                Terms of Service
              </a>
              <a
                href="/privacy"
                className="text-[14px] font-medium text-muted transition-colors hover:text-fg"
              >
                Privacy Policy
              </a>
            </div>
          </div>
        </div>

        <div>
          <h3 className="text-[13px] font-semibold text-subtle">Links</h3>
          <div className="mt-5">
            <a
              href="https://github.com/superloglabs"
              className="text-[14px] font-medium text-muted transition-colors hover:text-fg"
            >
              GitHub
            </a>
          </div>
        </div>
      </div>
      <div className="mt-16 text-[14px] font-medium text-subtle">© 2026 Pulsent Labs Inc.</div>
    </footer>
  );
}

function AuthModal({
  mode,
  onClose,
}: {
  mode: "sign-in" | "sign-up";
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  return (
    <dialog
      open
      className="fixed inset-0 z-50 flex h-full w-full max-w-none items-center justify-center bg-transparent px-4"
      aria-modal="true"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/85 backdrop-blur-md"
      />
      <div className="relative w-full max-w-md">
        <AuthForm
          initialMode={mode}
          onClose={onClose}
          onSuccess={() => {
            window.location.href = "/app";
          }}
        />
      </div>
    </dialog>
  );
}
