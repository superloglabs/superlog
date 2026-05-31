import { usePostHog } from "posthog-js/react";
import { useEffect, useState } from "react";
import { AuthForm } from "./AuthForm.tsx";
import { Btn, Label, Tile, Wordmark } from "./design/ui.tsx";

type AuthMode = "sign-in" | "sign-up" | null;

const plans = [
  {
    name: "Free",
    price: "Free",
    cadence: "",
    description: "For side projects and first installs where you want useful telemetry fast.",
    cta: "Start free",
    highlighted: false,
    features: [
      "3 agent_runs / month",
      "1M spans · 5M logs · 10M metric points / month",
      "3-day span retention, 7-day logs & metrics",
      "Onboarding in one prompt",
      "Logs, traces, metrics, dashboards, custom alerts",
      "Community support",
    ],
  },
  {
    name: "Developer",
    price: "$150",
    cadence: "per month",
    description: "For developers shipping fixes from real telemetry, every week.",
    cta: "Get started",
    highlighted: false,
    features: [
      "Everything in the Free plan",
      "25 agent_runs / month · $4 each after",
      "50M spans · 200M logs · 500M metric points / month",
      "7-day span retention, 30-day logs & metrics",
      "MCP access",
      "Email support",
    ],
  },
  {
    name: "Pro",
    price: "$300",
    cadence: "per month",
    description: "For teams that want more agent run throughput at a lower marginal price.",
    cta: "Get started",
    highlighted: true,
    features: [
      "Everything in the Developer plan",
      "60 agent_runs / month · $3 each after",
      "200M spans · 1B logs · 2B metric points / month",
      "14-day span retention, 90-day logs & metrics",
      "Slack, Linear, and GitHub integrations",
      "Priority support",
    ],
  },
  {
    name: "Enterprise",
    price: "Custom",
    cadence: "",
    description: "For organizations that need longer retention, security review, and hands-on rollout help.",
    cta: "Contact us",
    highlighted: false,
    features: [
      "Custom agent run & telemetry volumes",
      "Custom retention",
      "SAML and advanced access controls",
      "Private deployment options",
      "Dedicated rollout support",
      "Security and procurement support",
    ],
  },
];

const included = [
  ["OTel-first install", "Agent-generated PRs wire your services into vendor-neutral telemetry."],
  ["Incident control plane", "Similar errors become one clear incident with severity and impact."],
  ["Fix attempts", "Confident agent_runs become PRs; uncertain ones become useful handoffs."],
  ["MCP access", "Agents can query logs, traces, metrics, alerts, dashboards, and incidents."],
];

export function Pricing() {
  const posthog = usePostHog();
  const [authMode, setAuthMode] = useState<AuthMode>(() => {
    if (typeof window === "undefined") return null;
    const h = window.location.hash;
    if (h.includes("sso-callback") || h.includes("verify")) return "sign-in";
    return null;
  });

  const openSignIn = () => {
    posthog.capture("sign_in_clicked", { surface: "pricing" });
    setAuthMode("sign-in");
  };
  const openSignUp = () => {
    posthog.capture("sign_up_clicked", { surface: "pricing" });
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
          <section className="mt-8 grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
            {plans.map((plan) => (
              <PlanCard
                key={plan.name}
                plan={plan}
                onSignUp={openSignUp}
                onContact={() => {
                  window.open("https://cal.com/pulsent/superlog-discovery", "_blank", "noopener,noreferrer");
                }}
              />
            ))}
          </section>

          <section className="mt-24 grid scroll-mt-24 grid-cols-1 gap-6 lg:grid-cols-2">
            <header className="flex max-w-3xl flex-col justify-center lg:max-w-none">
              <h2 className="text-[28px] font-semibold tracking-tight text-fg md:text-[32px] lg:text-[36px] lg:leading-none">
                Included in every paid workspace.
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-muted lg:mt-6 lg:text-[16px] lg:leading-relaxed">
                Pricing stays tied to agentRuns. The telemetry plumbing, incident intelligence,
                and agent workflows come together as one system.
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
                href="https://cal.com/pulsent/superlog-discovery"
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
  onContact,
}: {
  plan: (typeof plans)[number];
  onSignUp: () => void;
  onContact: () => void;
}) {
  const action = plan.name === "Enterprise" ? onContact : onSignUp;

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

        <div className="mt-6 grid gap-2">
          {plan.features.map((feature) => (
            <div key={feature} className="flex items-start gap-3 border border-border bg-bg/35 p-3">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 bg-success" />
              <span className="text-[12.5px] leading-relaxed text-fg">{feature}</span>
            </div>
          ))}
        </div>

        <div className="mt-auto pt-6">
          <Btn
            variant={plan.highlighted ? "primary" : "secondary"}
            size="lg"
            className="w-full justify-center"
            onClick={action}
          >
            {plan.cta}
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
            <a
              href="/pricing"
              className="text-[14px] font-medium text-muted transition-colors hover:text-fg"
            >
              Pricing
            </a>
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
