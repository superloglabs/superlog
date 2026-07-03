import { usePostHog } from "posthog-js/react";
import { useEffect, useState } from "react";
import { AuthForm } from "./AuthForm.tsx";
import { Btn, Label, Tile, Wordmark } from "./design/ui.tsx";

type AuthMode = "sign-in" | "sign-up" | null;

// Where the "Contact us" / "Talk to us about Enterprise" links route. Enterprise
// is a contact-sales plan, so its CTA books a discovery call instead of opening
// the sign-up modal.
const ENTERPRISE_CONTACT_URL = "https://cal.com/pulsent/superlog-discovery";

// Pay-as-you-go unit prices. Source of truth: packages/billing/src/pricing.ts —
// keep in sync if those change.
const PAYG = {
  investigationUsd: 1.5,
  spansPerMillionUsd: 0.5,
  logsPerMillionUsd: 0.5,
  metricPointsPerMillionUsd: 0.15,
};

const FREE_INCLUDED = [
  "1M spans",
  "5M logs",
  "10M metric points",
  "30-day retention",
  "5 investigations / month",
];

type Pack = {
  name: string;
  price: string;
  cadence: string;
  description: string;
  cta: string;
  highlighted: boolean;
  features: string[];
  // When set, the CTA is a contact link to this URL instead of the sign-up modal.
  href?: string;
};

const packs: Pack[] = [
  {
    name: "Pro",
    price: "$150",
    cadence: "per month",
    description: "For developers shipping fixes from real telemetry, every week.",
    cta: "Get started",
    highlighted: false,
    features: [
      "120 investigation credits / month",
      "then $1.25 per investigation",
      "Telemetry metered at pay-as-you-go rates",
    ],
  },
  {
    name: "Max",
    price: "$300",
    cadence: "per month",
    description: "For teams that want more investigation throughput at a lower marginal price.",
    cta: "Get started",
    highlighted: true,
    features: [
      "300 investigation credits / month",
      "then $1.00 per investigation",
      "Telemetry metered at pay-as-you-go rates",
    ],
  },
  {
    name: "Enterprise",
    price: "Custom",
    cadence: "",
    description: "For high-volume teams that need committed pricing, security review, and support.",
    cta: "Contact us",
    highlighted: false,
    href: ENTERPRISE_CONTACT_URL,
    features: [
      "Custom investigation & telemetry volumes",
      "SAML / SSO and custom retention",
      "Dedicated support with SLAs",
      "Invoicing and annual commitments",
    ],
  },
];

const included = [
  ["OTel-first install", "Agent-generated PRs wire your services into vendor-neutral telemetry."],
  ["Incident control plane", "Similar errors become one clear incident with severity and impact."],
  ["Investigations as credits", "Each completed investigation is one credit; packs bundle them at a discount."],
  ["Metered telemetry", "Spans, logs, and metric points are billed per signal — cheaper than per-GB, metadata-neutral."],
];

export function Pricing() {
  const [authMode, setAuthMode] = useState<AuthMode>(() => {
    if (typeof window === "undefined") return null;
    const h = window.location.hash;
    if (h.includes("sso-callback") || h.includes("verify")) return "sign-in";
    return null;
  });

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
      <PricingNav onSignIn={openSignIn} onSignUp={openSignUp} />

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
          <section className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-3">
            {packs.map((plan) => (
              <PlanCard key={plan.name} plan={plan} onSignUp={openSignUp} />
            ))}
          </section>

          <section className="mt-24 grid scroll-mt-24 grid-cols-1 gap-6 lg:grid-cols-2">
            <header className="flex max-w-3xl flex-col justify-center lg:max-w-none">
              <h2 className="text-[28px] font-semibold tracking-tight text-fg md:text-[32px] lg:text-[36px] lg:leading-none">
                Included in every workspace.
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-muted lg:mt-6 lg:text-[16px] lg:leading-relaxed">
                You pay for telemetry you send and investigations you run — nothing else. The
                plumbing, incident intelligence, and agent workflows come together as one system.
                Need higher volumes, custom retention, or SAML? <a href={ENTERPRISE_CONTACT_URL} className="text-fg underline underline-offset-4 hover:text-accent" target="_blank" rel="noopener noreferrer">Talk to us about Enterprise</a>.
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
              <a
                href={ENTERPRISE_CONTACT_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-10 items-center rounded-sm border border-border px-4 text-[14px] font-medium tracking-tight text-fg transition-colors hover:border-border-strong"
              >
                Contact us
              </a>
            </div>
          </section>

          <PricingFooter />
        </div>
      </main>

      {authMode && <AuthModal mode={authMode} onClose={() => setAuthMode(null)} />}
    </div>
  );
}

function PricingNav({
  onSignIn,
  onSignUp,
}: {
  onSignIn: () => void;
  onSignUp: () => void;
}) {
  return (
    <header className="sticky top-0 z-40 bg-bg">
      <div className="mx-auto w-full max-w-[1400px] px-6 md:px-8 xl:px-12">
        <nav className="flex items-center justify-between py-5">
          <a href="/" aria-label="Superlog home" className="inline-flex items-center">
            <Wordmark />
          </a>
          <div className="flex items-center gap-3">
            <a
              href="/pricing"
              className="hidden text-[12px] font-medium text-muted transition-colors hover:text-fg sm:inline"
            >
              Pricing
            </a>
            <Btn variant="ghost" size="sm" onClick={onSignIn}>
              Sign in
            </Btn>
            <Btn variant="primary" size="sm" onClick={onSignUp}>
              Get started
            </Btn>
          </div>
        </nav>
      </div>
    </header>
  );
}

function PlanCard({
  plan,
  onSignUp,
}: {
  plan: Pack;
  onSignUp: () => void;
}) {
  return (
    <Tile
      className={`h-full rounded-lg ${
        plan.highlighted
          ? "bg-surface/70 shadow-[0_28px_100px_rgba(72,90,226,0.13)] ring-1 ring-accent/40"
          : "bg-surface/30"
      }`}
    >
      <div className="flex h-full min-h-[560px] flex-col">
        <h2 className="text-[27px] font-semibold tracking-tight text-fg">{plan.name}</h2>

        <div className="mt-6">
          <div className="flex items-end gap-2">
            <span className="text-[48px] font-semibold leading-none tracking-tight text-fg">
              {plan.price}
            </span>
            {plan.cadence && (
              <span className="pb-1.5 text-[13px] font-medium text-muted">{plan.cadence}</span>
            )}
          </div>
          <p className="mt-4 min-h-[66px] text-[13.5px] leading-relaxed text-muted">
            {plan.description}
          </p>
        </div>

        <ul className="mt-8 flex flex-col gap-2 text-[13.5px] leading-relaxed text-fg">
          {plan.features.map((feature) => (
            <li key={feature} className="flex items-baseline gap-2.5">
              <span className="text-muted">•</span>
              <span>{feature}</span>
            </li>
          ))}
        </ul>

        <div className="mt-auto pt-6">
          {plan.href ? (
            // Contact-sales CTA: an anchor styled to match the secondary button
            // (Btn only renders a <button>), routing to the discovery call.
            <a
              href={plan.href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-sm border border-border px-4 text-[14px] font-medium tracking-tight text-fg transition-all duration-150 hover:border-border-strong"
            >
              {plan.cta}
            </a>
          ) : (
            <Btn
              variant={plan.highlighted ? "primary" : "secondary"}
              size="lg"
              className="w-full justify-center"
              onClick={onSignUp}
            >
              {plan.cta}
            </Btn>
          )}
        </div>
      </div>
    </Tile>
  );
}

function FreeRow({ onSignUp }: { onSignUp: () => void }) {
  return (
    <Tile className="mt-8 rounded-lg bg-surface/30">
      <div className="flex flex-col gap-8 lg:flex-row lg:items-center lg:justify-between">
        {/* Left — plan name + description + what's included */}
        <div className="max-w-md">
          <h2 className="text-[27px] font-semibold tracking-tight text-fg">Free</h2>
          <p className="mt-2 text-[13.5px] leading-relaxed text-muted">
            For side projects and first installs — useful telemetry and a few investigations, free.
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

        {/* Right — price + CTA */}
        <div className="flex flex-col lg:items-end lg:text-right">
          <div className="flex items-end gap-2">
            <span className="text-[40px] font-semibold leading-none tracking-tight text-fg">$0</span>
            <span className="pb-1 text-[13px] font-medium text-muted">forever</span>
          </div>
          <Btn size="lg" className="mt-6 self-start lg:self-end" onClick={onSignUp}>
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

  const spansUsd = (spans / 1_000_000) * PAYG.spansPerMillionUsd;
  const logsUsd = (logs / 1_000_000) * PAYG.logsPerMillionUsd;
  const metricsUsd = (metrics / 1_000_000) * PAYG.metricPointsPerMillionUsd;
  const total = investigations * PAYG.investigationUsd + spansUsd + logsUsd + metricsUsd;

  return (
    <Tile className="mt-6 rounded-lg bg-surface/30">
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_240px]">
        <div>
          <h2 className="text-[27px] font-semibold tracking-tight text-fg">Pay as you go</h2>
          <p className="mt-2 text-[13.5px] leading-relaxed text-muted">
            Only pay for what you send — no base fee, no commitment. Drag to estimate your bill.
          </p>
          <div className="mt-7">
            <ScaleSlider
              label="Investigations"
              anchors={INVESTIGATION_ANCHORS}
              value={investigations}
              lineUsd={investigations * PAYG.investigationUsd}
              formatValue={(n) => `${n} / mo`}
              formatTick={(n) => `${n}`}
              onChange={setInvestigations}
            />
            <ScaleSlider
              label="Spans"
              anchors={TELEMETRY_ANCHORS}
              value={spans}
              lineUsd={spansUsd}
              formatValue={(n) => n.toLocaleString()}
              formatTick={formatCount}
              onChange={setSpans}
            />
            <ScaleSlider
              label="Logs"
              anchors={TELEMETRY_ANCHORS}
              value={logs}
              lineUsd={logsUsd}
              formatValue={(n) => n.toLocaleString()}
              formatTick={formatCount}
              onChange={setLogs}
            />
            <ScaleSlider
              label="Metric points"
              anchors={TELEMETRY_ANCHORS}
              value={metrics}
              lineUsd={metricsUsd}
              formatValue={(n) => n.toLocaleString()}
              formatTick={formatCount}
              onChange={setMetrics}
            />
          </div>
        </div>
        <div className="flex flex-col justify-center border-border lg:border-l lg:pl-8">
          <Label>estimated</Label>
          <div className="mt-3 flex items-end gap-2">
            <span className="text-[44px] font-semibold leading-none tracking-tight text-fg">
              ${total.toFixed(2)}
            </span>
            <span className="pb-1.5 text-[13px] font-medium text-muted">/ month</span>
          </div>
          <p className="mt-3 text-[12.5px] leading-relaxed text-muted">
            $1.50 / investigation · $0.50 / M spans · $0.50 / M logs · $0.15 / M metric points
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
            window.location.href = "/";
          }}
        />
      </div>
    </dialog>
  );
}
