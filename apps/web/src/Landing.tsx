import { usePostHog } from "posthog-js/react";
import { useEffect, useRef, useState } from "react";
import { AuthForm } from "./AuthForm.tsx";
import { Btn, Chip, Label, Tile, Wordmark } from "./design/ui.tsx";
import { INSTALL_PROMPT } from "./installPrompt.ts";
import { LANDING_DOCS_URL, LANDING_GITHUB_REPO_URL } from "./landingLinks.ts";

// ---------------------------------------------------------------------------
// Landing — /
// Dark canvas · cobalt accent · bento grids. Sign-in opens a modal overlay.
// ---------------------------------------------------------------------------

type AuthMode = "sign-in" | "sign-up" | null;

export function Landing({ initialAuthMode }: { initialAuthMode?: AuthMode } = {}) {
  const posthog = usePostHog();
  const [authMode, setAuthMode] = useState<AuthMode>(initialAuthMode ?? null);
  const openSignIn = () => {
    posthog?.capture("sign_in_clicked", { surface: "landing" });
    setAuthMode("sign-in");
  };
  const openSignUp = () => {
    posthog?.capture("sign_up_clicked", { surface: "landing" });
    setAuthMode("sign-up");
  };

  return (
    <div className="relative min-h-screen overflow-x-clip bg-bg font-sans text-fg">
      <TopNav onSignIn={openSignIn} onSignUp={openSignUp} />

      <main className="relative">
        <Hero />
        <ClientLogos />

        <div className="mx-auto w-full max-w-[1400px] px-0 pb-24 md:px-8 xl:px-12">
          <Section
            id="install"
            title="Full observability, zero hassle"
            subtitle="Our open-source agent wizard will explore your codebase, and add well-structured logs, traces and metrics via OpenTelemetry."
          >
            <InstallStory />
          </Section>

          <DriftSection />

          <Section
            id="incidents"
            title="No alert fatigue"
            subtitle="Similar errors become clear incidents, not a storm of repeated logs."
          >
            <IncidentStory />
          </Section>

          <FixSection />

          <PlatformSection />

          <FinalCTA />
          <Footer />
        </div>
      </main>

      {authMode && <AuthModal mode={authMode} onClose={() => setAuthMode(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Copy prompt card
// ---------------------------------------------------------------------------

function CopyPromptCard({ prompt }: { prompt: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function copy() {
    navigator.clipboard.writeText(prompt).catch(() => {});
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="w-full max-w-3xl rounded-2xl border border-white/15 bg-bg/82 p-4 shadow-[0_28px_90px_rgba(0,0,0,0.42)] backdrop-blur-md md:p-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <p className="break-words text-[15px] font-medium leading-relaxed text-fg md:text-[17px]">
          {prompt}
        </p>
        <button
          type="button"
          onClick={copy}
          className="w-max rounded-lg border border-white/15 bg-fg px-4 py-2 text-[12px] font-semibold uppercase tracking-[0.12em] text-bg transition-colors hover:bg-white"
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Nav — wordmark left, sign-in right
// ---------------------------------------------------------------------------

function TopNav({
  onSignIn,
  onSignUp,
}: {
  onSignIn: () => void;
  onSignUp: () => void;
}) {
  return (
    <header className="sticky top-0 z-40 bg-bg">
      <div className="mx-auto w-full max-w-[1400px] px-4 md:px-8 xl:px-12">
        <nav className="flex items-center justify-between py-5">
          <Wordmark />
          <div className="flex items-center gap-3">
            <a
              href={LANDING_GITHUB_REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="hidden items-center gap-1.5 text-[12px] font-medium text-muted transition-colors hover:text-fg sm:inline-flex"
            >
              <GitHubIcon />
              GitHub
            </a>
            <a
              href={LANDING_DOCS_URL}
              target="_blank"
              rel="noreferrer"
              className="hidden text-[12px] font-medium text-muted transition-colors hover:text-fg sm:inline"
            >
              Docs
            </a>
            <a
              href="/blog"
              className="hidden text-[12px] font-medium text-muted transition-colors hover:text-fg sm:inline"
            >
              Blog
            </a>
            <a
              href="/changelog"
              className="hidden text-[12px] font-medium text-muted transition-colors hover:text-fg sm:inline"
            >
              Changelog
            </a>
            <a
              href="/roadmap"
              className="hidden text-[12px] font-medium text-muted transition-colors hover:text-fg sm:inline"
            >
              Roadmap
            </a>
            <a
              href="/team"
              className="hidden text-[12px] font-medium text-muted transition-colors hover:text-fg sm:inline"
            >
              Team
            </a>
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

function GitHubIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38v-1.33c-2.22.48-2.69-1.07-2.69-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.81.06 1.23.83 1.23.83.72 1.23 1.88.87 2.34.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.13 0 0 .67-.21 2.2.82A7.6 7.6 0 0 1 8 3.86c.68 0 1.36.09 2 .27 1.53-1.03 2.2-.82 2.2-.82.44 1.11.16 1.93.08 2.13.51.56.82 1.28.82 2.15 0 3.07-1.87 3.74-3.65 3.94.29.25.54.73.54 1.48v2.19c0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Hero
// ---------------------------------------------------------------------------

function Hero() {
  return (
    <section className="relative px-0 pb-8 pt-20 md:px-8 md:pt-24 xl:px-12">
      <div className="mx-auto max-w-[1400px]">
        <div className="px-4 text-center md:px-0">
          <div className="mb-10 inline-flex items-center gap-2 text-[11px] font-medium text-muted md:text-[12px]">
            <img src="/yc-logo-square.svg" alt="" aria-hidden="true" className="h-4 w-4" />
            <span>Backed by Y Combinator</span>
          </div>
          <h1
            className="mx-auto max-w-4xl text-balance text-[2.4375rem] leading-[0.98] tracking-tight text-fg md:text-[4.3125rem] lg:text-[57px]"
            style={{ fontWeight: 450 }}
          >
            Observability that fixes your bugs
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-[13.5px] leading-relaxed text-muted md:text-[18px]">
            Install in one prompt, get PRs in Slack
          </p>
        </div>

        <div className="relative mx-auto mt-14 rounded-none md:rounded-lg">
          <div className="absolute inset-0 overflow-hidden rounded-none md:rounded-lg">
            <img
              src="/hero-rocket.png"
              alt=""
              aria-hidden="true"
              className="absolute inset-0 h-full w-full object-cover object-top"
            />
            <div className="absolute inset-0 bg-[linear-gradient(0deg,rgba(8,9,11,0.72),rgba(8,9,11,0.08)_64%),linear-gradient(90deg,rgba(8,9,11,0.54),rgba(8,9,11,0.06)_56%,rgba(8,9,11,0.42))]" />
          </div>
          <CodingAgentWindow />
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Client logos — seamless white-logo marquee under the hero
// ---------------------------------------------------------------------------

// Client logos. Brand marks live in apps/web/public/logos and get forced to one
// monochrome white (brightness-0 invert) so the row reads as a single elegant
// set instead of a jumble of brand colors. `icon: true` appends the company name
// beside a bare mark so it's legible; entries with no `src` are typeset until a
// clean transparent/mono asset lands.
const CLIENT_LOGOS: { name: string; src?: string; icon?: boolean; label?: string }[] = [
  { name: "Plato", src: "/logos/plato.svg" },
  { name: "LightSprint", src: "/logos/lightsprint.png" },
  { name: "Datost", src: "/logos/datost.svg", icon: true },
  { name: "Clawvisor", src: "/logos/clawvisor.svg", icon: true },
  { name: "Kinect", src: "/logos/kinect.svg", icon: true },
  { name: "Nautilus", src: "/logos/nautilus.png" },
  { name: "Linzumi", src: "/logos/linzumi.svg", icon: true },
  { name: "Juno", src: "/logos/juno.png", icon: true, label: "juno" },
  { name: "Akkari", src: "/logos/akkari.svg", icon: true },
  { name: "Trellis", src: "/logos/trellis.svg", icon: true },
  { name: "Hedge", label: "hedge." },
  { name: "Prism", src: "/logos/prism.svg", icon: true },
];

function ClientLogos() {
  return (
    <section aria-label="Trusted by teams" className="relative mt-12 md:mt-16">
      <div className="mx-auto w-full max-w-[1400px] px-4 md:px-8 xl:px-12">
        <p className="mb-6 text-center text-[11px] font-medium uppercase tracking-[0.2em] text-subtle md:mb-8 md:text-[12px]">
          Trusted by teams at
        </p>
        <div className="marquee-fade overflow-hidden py-2">
          <ul className="marquee-track flex w-max items-center">
            {[0, 1].map((copy) =>
              CLIENT_LOGOS.map((logo) => (
                <li
                  key={`${copy}-${logo.name}`}
                  aria-hidden={copy === 1 || undefined}
                  title={logo.name}
                  className="flex shrink-0 items-center gap-2.5 pr-14 opacity-60 transition-opacity duration-300 hover:opacity-100 md:pr-24"
                >
                  {logo.src && (
                    <img
                      src={logo.src}
                      alt={logo.name}
                      loading="lazy"
                      draggable={false}
                      className="h-6 w-auto max-w-[160px] object-contain brightness-0 invert md:h-7"
                    />
                  )}
                  {logo.icon && (
                    <span className="whitespace-nowrap text-[17px] font-medium tracking-tight text-fg md:text-[19px]">
                      {logo.label ?? logo.name}
                    </span>
                  )}
                  {!logo.src && (
                    <span className="whitespace-nowrap text-[19px] font-semibold tracking-tight text-fg md:text-[21px]">
                      {logo.label ?? logo.name}
                    </span>
                  )}
                </li>
              )),
            )}
          </ul>
        </div>
      </div>
    </section>
  );
}

function CodingAgentWindow() {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(INSTALL_PROMPT);
    } catch {
      return;
    }
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="relative flex min-h-[520px] flex-col items-center justify-center gap-4 p-5 md:min-h-[620px] md:gap-5 md:p-8">
      <div className="mx-auto w-full overflow-hidden rounded-2xl border border-white/10 bg-[#050608] shadow-[0_28px_100px_rgba(0,0,0,0.65)] lg:max-w-[75%]">
        <div className="flex items-center gap-2 bg-[#050608] px-4 py-3">
          <span className="h-2.5 w-2.5 rounded-full bg-danger" />
          <span className="h-2.5 w-2.5 rounded-full bg-warning" />
          <span className="h-2.5 w-2.5 rounded-full bg-success" />
          <span className="ml-3 font-mono text-[10px] uppercase tracking-[0.2em] text-subtle">
            coding agent
          </span>
        </div>
        <div className="grid gap-4 p-4 font-mono text-[12px] leading-relaxed md:p-5 md:text-[13px]">
          <div className="bg-[#050608] p-4">
            <div className="mb-2 text-subtle">prompt</div>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 break-words text-fg">
                <span className="mr-1 text-subtle" aria-hidden="true">
                  &gt;
                </span>
                {INSTALL_PROMPT}
                <span className="ml-1 inline-block h-4 w-2 translate-y-0.5 animate-pulse bg-accent" />
              </div>
              <button
                type="button"
                onClick={copy}
                className="shrink-0 rounded-md bg-accent px-3 py-1.5 font-sans text-[11px] font-semibold uppercase tracking-[0.12em] text-accent-ink transition-[filter] hover:brightness-110"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        </div>
      </div>
      <OnboardingAgenda />
    </div>
  );
}

function OnboardingAgenda() {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const steps = [
    "Map every app, service, and edge function in your repo",
    "Install native OpenTelemetry — traces, logs, metrics — per language",
    "Open superlog.sh in a browser to finish signup in parallel",
    "Add spans, counters, and structured logs around critical operations",
    "Verify the app still runs and OTLP reaches /v1/traces, /logs, /metrics",
  ];

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!containerRef.current) return;
      if (e.target instanceof Node && containerRef.current.contains(e.target)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function toggle() {
    setOpen((prev) => !prev);
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-bg/70 px-4 py-2 text-[12px] font-medium text-fg shadow-[0_12px_30px_rgba(0,0,0,0.32)] backdrop-blur-md transition-colors hover:border-white/30 hover:bg-bg/85 md:text-[13px]"
      >
        <span
          aria-hidden="true"
          className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-white/30 text-[10px] font-semibold text-subtle"
        >
          ?
        </span>
        <span>What will the agent do?</span>
        <span
          aria-hidden="true"
          className={`text-subtle transition-transform ${open ? "rotate-180" : ""}`}
        >
          ▾
        </span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="What the agent will do"
          className="absolute left-1/2 top-[calc(100%+10px)] z-30 w-[min(92vw,520px)] -translate-x-1/2 rounded-2xl border border-white/15 bg-bg/95 p-5 text-left shadow-[0_28px_80px_rgba(0,0,0,0.55)] backdrop-blur-md md:p-6"
        >
          <span
            aria-hidden="true"
            className="absolute -top-1.5 left-1/2 h-3 w-3 -translate-x-1/2 rotate-45 border-l border-t border-white/15 bg-bg/95"
          />
          <div className="mb-3 font-mono text-[10px] uppercase tracking-[0.18em] text-subtle">
            via superloglabs/skills
          </div>
          <ol className="grid gap-2 text-[13px] leading-relaxed text-fg md:text-[14px]">
            {steps.map((step, i) => (
              <li key={step} className="flex gap-3">
                <span className="w-5 shrink-0 font-mono text-subtle" aria-hidden="true">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="min-w-0 break-words">{step}</span>
              </li>
            ))}
          </ol>
          <p className="mt-4 text-[12px] leading-relaxed text-muted md:text-[13px]">
            Public ingest token is inlined in the bootstrap — no env vars, no .env edits. Existing
            vendors (Sentry, Datadog, etc.) stay in place.
          </p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section shell
// ---------------------------------------------------------------------------

function Section({
  id,
  title,
  subtitle,
  children,
}: {
  id?: string;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="mt-24 scroll-mt-24">
      <header className="mb-6 grid grid-cols-1 gap-2 px-4 text-center md:px-0 lg:grid-cols-2 lg:items-end lg:text-left">
        <h2 className="mx-auto text-[28px] font-semibold tracking-tight text-fg md:whitespace-nowrap md:text-[32px] lg:mx-0 lg:text-[36px] lg:leading-none">
          {title}
        </h2>
        <p className="mx-auto max-w-3xl text-sm leading-relaxed text-muted lg:mx-0 lg:max-w-none lg:text-[16px] lg:leading-relaxed">
          {subtitle}
        </p>
      </header>
      <div>{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Story sections
// ---------------------------------------------------------------------------

function InstallStory() {
  return (
    <div className="relative mt-24 min-h-[420px] overflow-hidden rounded-none md:min-h-[520px] md:rounded-lg">
      <img
        src="/observability-motion.jpg"
        alt=""
        aria-hidden="true"
        className="absolute inset-0 h-full w-full object-cover"
      />
      <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(8,9,11,0.88),rgba(8,9,11,0.5)_48%,rgba(8,9,11,0.2)),linear-gradient(0deg,rgba(8,9,11,0.68),rgba(8,9,11,0.08)_55%)]" />

      <div className="relative flex min-h-[420px] items-end p-5 md:min-h-[520px] md:p-8">
        <div className="w-full max-w-2xl border border-border-strong bg-bg/80 p-4 font-mono text-[11.5px] leading-relaxed shadow-[0_24px_80px_rgba(0,0,0,0.45)] backdrop-blur-md md:p-5 md:text-[12px]">
          <Label>pull request preview</Label>
          <div className="text-subtle">$ npx @superlog/cli</div>
          <div className="mt-1 text-fg">
            <span className="text-success">✔</span> found api, worker, web
          </div>
          <div className="text-fg">
            <span className="text-success">✔</span> added request spans, queue metrics, structured
            error logs
          </div>
          <div className="text-fg">
            <span className="text-success">✔</span> opened superlog/install-otel
          </div>
        </div>
      </div>
    </div>
  );
}

function DriftSection() {
  return (
    <section id="drift" className="mt-24 grid scroll-mt-24 grid-cols-1 gap-6 lg:grid-cols-2">
      <header className="flex max-w-3xl flex-col justify-center px-4 text-center md:px-0 lg:max-w-none lg:text-left">
        <h2 className="text-[28px] font-semibold tracking-tight text-fg md:whitespace-nowrap md:text-[32px] lg:text-[36px] lg:leading-none">
          Observability that doesn’t drift.
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted lg:mt-6 lg:text-[16px] lg:leading-relaxed">
          Superlog scans your codebase and infrastructure to add new alerts, metrics and dashboards,
          preventing tricky failure modes and observability decay.
        </p>
      </header>

      <div className="relative min-h-[420px] overflow-hidden rounded-none md:min-h-[520px] md:rounded-lg">
        <img
          src="/observability-drift.jpg"
          alt=""
          aria-hidden="true"
          className="absolute inset-0 h-full w-full object-cover"
        />
        <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(8,9,11,0.72),rgba(8,9,11,0.36)),linear-gradient(0deg,rgba(8,9,11,0.72),rgba(8,9,11,0.12)_58%)]" />
        <div className="relative flex min-h-[420px] items-end p-5 md:min-h-[520px] md:p-8">
          <div className="grid w-full gap-3">
            <Label>continuous scan</Label>
            <SignalRow label="new alert" value="vendor timeout by service" />
            <SignalRow label="new metric" value="checkout.failure_rate" />
            <SignalRow label="new dashboard" value="queue depth and worker lag" />
          </div>
        </div>
      </div>
    </section>
  );
}
function IncidentStory() {
  const blocks = [
    {
      kind: "fingerprint" as const,
      title: "Fingerprinting and grouping.",
      body: "Superlog merges similar errors into clear-cut incidents.",
    },
    {
      kind: "impact" as const,
      title: "Severity and impact.",
      body: "Instead of repeated error logs, Superlog provides a summary, a severity score (SEV1-3) and an impact assessment.",
    },
    {
      kind: "analysis" as const,
      title: "Confidence and analysis.",
      body: "We maintain a custom suite of evaluations to make sure summaries and assessments are terse and relevant.",
    },
  ];

  return (
    <div className="mt-24 grid grid-cols-1 gap-y-12 md:grid-cols-12 md:gap-x-10">
      {blocks.map((block) => (
        <div key={block.kind} className="px-4 md:col-span-4 md:px-0">
          <IncidentIllustration kind={block.kind} />
          <h3 className="mt-6 text-center text-[22px] font-semibold tracking-tight text-fg md:text-left">
            {block.title}
          </h3>
          <p className="mt-3 text-[13.5px] leading-relaxed text-muted">{block.body}</p>
        </div>
      ))}
    </div>
  );
}

function IncidentIllustration({
  kind,
}: {
  kind: "fingerprint" | "impact" | "analysis";
}) {
  if (kind === "fingerprint") {
    return (
      <div className="relative h-36 w-full overflow-hidden" aria-hidden="true">
        {[
          ["top-2", "postgres error", "db.primary", "0ms"],
          ["top-9", "api error", "api.checkout", "900ms"],
          ["top-16", "queue error", "worker.orders", "1800ms"],
        ].map(([position, title, source, delay]) => (
          <div key={source} className={`absolute left-1/2 ${position} w-64 -translate-x-1/2`}>
            <div
              className="incident-alert-card rounded-xl border border-border bg-surface-2/95 px-4 py-3 shadow-[0_18px_42px_rgba(0,0,0,0.34)] backdrop-blur"
              style={{ animationDelay: delay }}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-[9px] font-medium uppercase tracking-[0.18em] text-muted">
                  alert
                </span>
                <span className="h-1.5 w-1.5 rounded-full bg-muted/60" />
              </div>
              <div className="mt-2 text-[12px] font-medium text-fg">{title}</div>
              <div className="mt-1 text-[10px] text-muted">service.{source}</div>
            </div>
          </div>
        ))}
        <div className="incident-summary-card absolute left-1/2 top-8 w-64 -translate-x-1/2 rounded-xl border border-border-strong bg-fg px-5 py-4 text-bg shadow-[0_24px_58px_rgba(0,0,0,0.48)]">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-danger">
              SEV-1
            </span>
            <span className="rounded-full bg-bg/15 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-bg/70">
              merged
            </span>
          </div>
          <div className="mt-3 text-[18px] font-semibold leading-none tracking-tight">
            database is down
          </div>
          <div className="mt-2 text-[11px] font-medium text-bg/70">impact: checkout down</div>
        </div>
      </div>
    );
  }

  if (kind === "impact") {
    return (
      <div className="relative h-36 w-full overflow-hidden" aria-hidden="true">
        <div className="severity-main-card absolute left-1/2 top-8 w-72 -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-surface-2/95 px-5 py-4 text-fg shadow-[0_18px_42px_rgba(0,0,0,0.34)]">
          <div className="severity-shimmer absolute inset-0 opacity-0" />
          <div className="relative text-[9px] font-medium uppercase tracking-[0.18em] text-muted">
            incident
          </div>
          <div className="relative mt-3 h-5 text-[16px] font-semibold leading-none tracking-tight">
            <span className="severity-old-label absolute inset-0">HTTP 400: Unauthorized</span>
            <span className="severity-new-label absolute inset-0">Stripe credential not set</span>
          </div>
          <div className="severity-final-details relative mt-3 flex items-center gap-1.5 whitespace-nowrap opacity-0">
            <span className="rounded-full bg-danger/10 px-2 py-0.5 text-[8.5px] font-bold uppercase tracking-[0.12em] text-danger">
              SEV-1
            </span>
            <span className="rounded-full bg-fg/10 px-2 py-0.5 text-[8.5px] font-semibold uppercase tracking-[0.08em] text-muted">
              impact: checkout down
            </span>
          </div>
        </div>
        {[
          ["severity-bubble-one", "sev1"],
          ["severity-bubble-two", "revenue impact"],
          ["severity-bubble-three", "checkout down"],
        ].map(([className, label]) => (
          <div
            key={label}
            className={`${className} severity-bubble absolute rounded-full border border-border bg-surface-2/95 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted shadow-[0_12px_30px_rgba(0,0,0,0.24)]`}
          >
            {label}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="relative h-36 w-full overflow-hidden" aria-hidden="true">
      <div className="absolute left-6 right-6 top-14 border-t border-dashed border-fg/35" />
      <div className="absolute left-6 top-9 text-[10px] font-medium uppercase tracking-[0.14em] text-muted">
        threshold
      </div>
      <div className="absolute bottom-4 left-8 right-8 flex h-16 items-end gap-2">
        {[
          ["p10", 28],
          ["p25", 36],
          ["p40", 48],
          ["p55", 62],
          ["p70", 78],
          ["p85", 92],
          ["p99", 100],
        ].map(([id, height]) => (
          <div
            key={id}
            className="flex-1 rounded-t-sm border border-border bg-surface-2/90"
            style={{ height: `${height}%` }}
          />
        ))}
      </div>
      <div className="absolute bottom-4 left-8 right-8 h-px bg-fg/10" />
    </div>
  );
}

function FixSection() {
  return (
    <section id="fix" className="mt-24 grid scroll-mt-24 grid-cols-1 gap-6 lg:grid-cols-2">
      <header className="flex max-w-3xl flex-col items-center justify-center px-4 text-center md:px-0 lg:max-w-none lg:items-start lg:text-left">
        <h2 className="text-[28px] font-semibold tracking-tight text-fg md:whitespace-nowrap md:text-[32px] lg:text-[36px] lg:leading-none">
          We fix bugs.
        </h2>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted lg:mt-6 lg:text-[16px] lg:leading-relaxed">
          Superlog prepares a resolution PR for every incident. If Confidence Gate fails, it posts
          findings for the investigating team and pulls in the engineers who can add context.
        </p>
      </header>

      <div className="relative min-h-[420px] overflow-hidden rounded-none md:min-h-[520px] md:rounded-lg">
        <img
          src="/fix-bugs-motion.png"
          alt=""
          aria-hidden="true"
          className="absolute inset-0 h-full w-full object-cover"
        />
        <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(8,9,11,0.48),rgba(8,9,11,0.18)),linear-gradient(0deg,rgba(8,9,11,0.68),rgba(8,9,11,0.04)_62%)]" />
        <div className="relative flex min-h-[420px] items-center p-5 md:min-h-[520px] md:p-8">
          <SlackPrNotification />
        </div>
      </div>
    </section>
  );
}

function SlackPrNotification() {
  return (
    <div className="w-full max-w-xl rounded-2xl bg-[#f8f8f6] p-5 text-[#1d1c1d] shadow-[0_28px_80px_rgba(0,0,0,0.42)] ring-1 ring-black/10">
      <div className="flex items-start gap-3">
        <div className="mt-1 flex h-10 w-10 items-center justify-center rounded-lg bg-white shadow-sm ring-1 ring-black/10">
          <img src="/superlog-pictogram-dark.svg" alt="" aria-hidden="true" className="h-7 w-7" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[15px] font-bold leading-none">Superlog</span>
            <span className="rounded bg-black/10 px-1.5 py-0.5 text-[10px] font-bold uppercase leading-none text-black/70">
              app
            </span>
            <span className="text-[12px] text-black/55">2:23 AM</span>
          </div>

          <div className="mt-3 flex items-center gap-2 text-[16px] font-bold leading-tight">
            <span>💡</span>
            <span>PR Ready</span>
          </div>

          <h3 className="mt-3 text-[16px] font-bold leading-snug tracking-tight">
            Fix Stripe credential fallback returning HTTP 400 instead of a clear setup error
          </h3>
          <p className="mt-2 text-[13px] italic leading-relaxed text-black/80">
            Checkout is down because the Stripe secret is missing in production. Superlog prepared a
            PR that validates the credential on boot, returns an actionable setup error, and adds a
            regression test for the payment path.
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <code className="rounded border border-black/15 bg-white px-1.5 py-0.5 font-mono text-[12px] text-[#d91a4d]">
              Default
            </code>
            <span className="text-black/45">·</span>
            <code className="rounded border border-black/15 bg-white px-1.5 py-0.5 font-mono text-[12px] text-[#d91a4d]">
              checkout-api
            </code>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded-md border border-black/25 bg-white px-3 py-2 text-[12px] font-bold text-[#1d1c1d] shadow-sm"
            >
              Open in Superlog
            </button>
            <button
              type="button"
              className="rounded-md border border-black/25 bg-white px-3 py-2 text-[12px] font-bold text-[#1d1c1d] shadow-sm"
            >
              View PR
            </button>
          </div>

          <div className="mt-4 flex items-center gap-2 text-[12px] text-black/60">
            <span className="font-bold text-[#1264a3]">3 replies</span>
            <span>Last reply 2 min ago</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function PlatformSection() {
  return (
    <section id="platform" className="mt-24 scroll-mt-24">
      <header className="mb-24 grid grid-cols-1 gap-2 px-4 text-center md:px-0 lg:grid-cols-2 lg:items-end lg:text-left">
        <h2 className="mx-auto text-[28px] font-semibold tracking-tight text-fg md:whitespace-nowrap md:text-[32px] lg:mx-0 lg:text-[36px] lg:leading-none">
          Zero clicks.
        </h2>
        <p className="mx-auto max-w-3xl text-sm leading-relaxed text-muted lg:mx-0 lg:max-w-none lg:text-[16px] lg:leading-relaxed">
          Logs, traces, metrics, alerts, dashboards: all fully available through MCP, so that you
          don’t have to maintain another platform.
        </p>
      </header>

      <div className="relative min-h-[420px] overflow-hidden rounded-none md:min-h-[560px] md:rounded-lg">
        <img
          src="/zero-clicks-motion.png"
          alt=""
          aria-hidden="true"
          className="absolute inset-0 h-full w-full object-cover"
        />
        <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(8,9,11,0.82),rgba(8,9,11,0.42)_48%,rgba(8,9,11,0.16)),linear-gradient(0deg,rgba(8,9,11,0.66),rgba(8,9,11,0.08)_58%)]" />
        <div className="relative flex min-h-[420px] items-center justify-center p-5 md:min-h-[560px] md:p-8">
          <McpAgentWindow />
        </div>
      </div>
    </section>
  );
}

function McpAgentWindow() {
  return (
    <div className="w-full max-w-3xl rounded-2xl bg-[#231f1d]/95 p-6 text-[#f2f0eb] shadow-[0_30px_90px_rgba(0,0,0,0.58)] md:p-8">
      <div className="space-y-7">
        <div className="mcp-prompt-appear rounded-xl bg-[#171512] px-5 py-4 text-[18px] font-medium leading-relaxed text-[#f2f0eb] shadow-[0_12px_34px_rgba(0,0,0,0.28)] md:text-[20px]">
          can you prepare a cloud cost dashboard for checkout-api?
        </div>

        <div className="space-y-5 text-[18px] leading-relaxed md:text-[20px]">
          <div className="mcp-search-line relative h-7 text-[#9e9991]">
            <div className="mcp-searching-text absolute inset-0">
              <span className="mcp-thinking-shimmer">Searching...</span>
            </div>
            <div className="mcp-searched-text absolute inset-0">
              Searched <span className="text-[#6f6a64]">cloud costs, deploys, and incidents</span>
            </div>
          </div>
        </div>

        <div className="mcp-created-appear text-[18px] leading-relaxed text-[#9e9991] md:text-[20px]">
          <span className="text-[#f2f0eb]">Created</span>{" "}
          <span className="text-[#6f6a64]">cloud-costs</span>
        </div>

        <div className="mcp-reply-appear text-[18px] leading-relaxed text-[#f2f0eb] md:text-[20px]">
          <p className="mcp-reply-type mcp-reply-type-one overflow-hidden whitespace-nowrap">
            Sure! I've added a dashboard for checkout-api with spend, deploys,
          </p>
          <p className="mcp-reply-type mcp-reply-type-two overflow-hidden whitespace-nowrap">
            alerts, cost anomalies, and owners.
          </p>
        </div>
      </div>
    </div>
  );
}

function SignalRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-border bg-surface-2 p-3">
      <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-subtle">{label}</div>
      <div className="mt-2 text-[13px] font-medium text-fg">{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Final CTA
// ---------------------------------------------------------------------------

function FinalCTA() {
  return (
    <section className="mt-24">
      <div className="px-4 text-center md:px-0">
        <h2 className="text-[38px] font-semibold leading-none tracking-tight text-fg md:text-[56px]">
          No lock-in.
        </h2>
        <p className="mt-4 text-[18px] font-medium leading-relaxed text-muted md:text-[22px]">
          Onboard in one prompt
        </p>
      </div>

      <div className="relative mt-16 min-h-[420px] overflow-hidden rounded-none px-4 py-12 md:min-h-[560px] md:rounded-lg md:px-10 md:py-16">
        <img
          src="/no-lock-in-motion.jpg"
          alt=""
          aria-hidden="true"
          className="absolute inset-0 h-full w-full object-cover"
        />
        <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(8,9,11,0.74),rgba(8,9,11,0.34)_48%,rgba(8,9,11,0.16)),linear-gradient(0deg,rgba(8,9,11,0.7),rgba(8,9,11,0.08)_60%)]" />

        <div className="relative flex min-h-[324px] items-center justify-center md:min-h-[432px]">
          <CopyPromptCard prompt={INSTALL_PROMPT} />
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

function Footer() {
  return (
    <footer className="mt-16 bg-bg py-14 md:py-16">
      <div className="grid gap-10 px-4 text-center md:grid-cols-[180px_180px] md:justify-end md:px-0 md:text-left">
        <div>
          <h3 className="text-[13px] font-semibold text-subtle">Product</h3>
          <div className="mt-5">
            <div className="flex flex-col items-center gap-3 md:items-start">
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
      <div className="mt-16 px-4 text-center text-[14px] font-medium text-subtle md:px-0 md:text-left">
        © 2026 Pulsent Labs Inc.
      </div>
    </footer>
  );
}

// ---------------------------------------------------------------------------
// Auth modal
// ---------------------------------------------------------------------------

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
