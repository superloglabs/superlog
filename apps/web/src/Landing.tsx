import { usePostHog } from "posthog-js/react";
import { useEffect, useRef, useState } from "react";
import { AuthForm } from "./AuthForm.tsx";
import { Arrow, Btn, Chip, Label, Tile, Wordmark } from "./design/ui.tsx";
import { FluidSignalField } from "./FluidSignalField.tsx";
import { formatStarCount } from "./githubStars.ts";
import { INSTALL_PROMPT } from "./installPrompt.ts";
import { LANDING_DOCS_URL, LANDING_GITHUB_REPO_URL } from "./landingLinks.ts";
import { useGithubStarCount } from "./useGithubStars.ts";

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
        <Hero onSignUp={openSignUp} />
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
// Nav — three columns: brand left · links center · auth actions right.
// The center column is `hidden lg:flex`. Below lg the `1fr auto 1fr` grid
// collapses to brand-left / actions-right and stays balanced. We wait for lg
// (not md) because at the ~704px md content width the six links plus the
// wordmark and action group overflow, and grid can't keep the two 1fr side
// tracks equal once the right track's min-content exceeds half the free space
// — the center would drift and the links could butt against the buttons.
// ---------------------------------------------------------------------------

const NAV_LINKS: { href: string; label: string; external?: boolean }[] = [
  { href: LANDING_DOCS_URL, label: "Docs", external: true },
  { href: "/blog", label: "Blog" },
  { href: "/changelog", label: "Changelog" },
  { href: "/roadmap", label: "Roadmap" },
  { href: "/team", label: "Team" },
  { href: "/pricing", label: "Pricing" },
];

export function TopNav({
  onSignIn,
  onSignUp,
}: {
  onSignIn: () => void;
  onSignUp: () => void;
}) {
  const stars = useGithubStarCount(LANDING_GITHUB_REPO_URL);
  return (
    <header className="sticky top-0 z-40 bg-bg">
      <div className="mx-auto w-full max-w-[1400px] px-4 md:px-8 xl:px-12">
        <nav className="grid grid-cols-[1fr_auto_1fr] items-center py-5">
          <div className="flex items-center justify-self-start">
            <a
              href="/"
              aria-label="Superlog home"
              className="landing-nav-unblur inline-flex items-center"
              style={{ animationDelay: "20ms" }}
            >
              <Wordmark />
            </a>
          </div>

          <div className="hidden items-center gap-6 justify-self-center lg:flex">
            {NAV_LINKS.map((link, index) => (
              <a
                key={link.href}
                href={link.href}
                target={link.external ? "_blank" : undefined}
                rel={link.external ? "noreferrer" : undefined}
                className="landing-nav-unblur text-[12px] font-medium text-muted transition-colors hover:text-fg"
                style={{ animationDelay: `${80 + index * 55}ms` }}
              >
                {link.label}
              </a>
            ))}
          </div>

          <div className="flex items-center gap-3 justify-self-end">
            <a
              href={LANDING_GITHUB_REPO_URL}
              target="_blank"
              rel="noreferrer"
              aria-label={
                stars != null
                  ? `Superlog on GitHub, ${stars.toLocaleString()} stars`
                  : "Superlog on GitHub"
              }
              className="landing-nav-unblur hidden items-center gap-1.5 text-[12px] font-medium text-muted transition-colors hover:text-fg md:inline-flex"
              style={{ animationDelay: "430ms" }}
            >
              <GitHubIcon />
              <span className="tabular-nums">{stars != null ? formatStarCount(stars) : "GitHub"}</span>
            </a>
            <Btn variant="ghost" size="sm" onClick={onSignIn}>
              <span className="landing-nav-unblur" style={{ animationDelay: "485ms" }}>
                Sign in
              </span>
            </Btn>
            <span
              className="landing-nav-unblur inline-flex"
              style={{ animationDelay: "540ms" }}
            >
              <Btn variant="primary" size="sm" onClick={onSignUp}>
                Get started
              </Btn>
            </span>
          </div>
        </nav>
      </div>
    </header>
  );
}

function GitHubIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38v-1.33c-2.22.48-2.69-1.07-2.69-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.81.06 1.23.83 1.23.83.72 1.23 1.88.87 2.34.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.13 0 0 .67-.21 2.2.82A7.6 7.6 0 0 1 8 3.86c.68 0 1.36.09 2 .27 1.53-1.03 2.2-.82 2.2-.82.44 1.11.16 1.93.08 2.13.51.56.82 1.28.82 2.15 0 3.07-1.87 3.74-3.65 3.94.29.25.54.73.54 1.48v2.19c0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Hero
// ---------------------------------------------------------------------------

function Hero({ onSignUp }: { onSignUp: () => void }) {
  return (
    <section className="relative overflow-hidden bg-bg px-4 md:px-8 xl:px-12">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-0 h-full w-[min(2800px,190vw)] -translate-x-1/2 overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_5%,black_95%,transparent)] [-webkit-mask-image:linear-gradient(to_right,transparent,black_5%,black_95%,transparent)]">
          <FluidSignalField />
        </div>
        <div className="landing-fluid-hero-overlay absolute inset-0" />
      </div>

      <div className="relative mx-auto grid min-h-[calc(100svh-64px)] max-w-[1400px] items-center gap-10 pb-8 pt-12 md:pt-16 lg:grid-cols-[minmax(0,560px)_minmax(0,1fr)] lg:gap-[72px] lg:pb-10 lg:pt-24">
        <div className="flex flex-col items-center text-center lg:items-start lg:text-left">
          <div
            className="landing-hero-unblur mb-10 inline-flex items-center gap-2 text-[11px] font-medium text-muted md:text-[12px]"
            style={{ animationDelay: "180ms" }}
          >
            <img src="/yc-logo-square.svg" alt="" aria-hidden="true" className="h-4 w-4" />
            <span>Backed by Y Combinator</span>
          </div>
          <h1
            className="landing-hero-unblur max-w-[410px] text-balance text-[2.4375rem] leading-[0.98] tracking-[-0.035em] text-fg md:text-[57px] md:leading-[56px]"
            style={{ fontWeight: 450, animationDelay: "260ms" }}
          >
            Observability that fixes your bugs
          </h1>
          <p
            className="landing-hero-unblur mt-5 max-w-lg text-[13.5px] leading-relaxed text-muted md:text-[18px]"
            style={{ animationDelay: "340ms" }}
          >
            Install in one prompt, get PRs in Slack
          </p>
          <div
            className="landing-hero-unblur mt-8 flex flex-col items-center gap-3 sm:flex-row lg:items-start"
            style={{ animationDelay: "420ms" }}
          >
            <Btn variant="primary" size="lg" onClick={onSignUp}>
              Get started
              <Arrow />
            </Btn>
            <HeroInstallCommand />
          </div>
        </div>

        <div className="flex w-full items-center justify-center lg:justify-end">
          <HeroSlackMessage />
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

function HeroInstallCommand() {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const command = "npx skills add superloglabs/skills --all";

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      return;
    }
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? "Install command copied" : "Copy install command"}
      className="inline-flex h-10 max-w-full items-center gap-3 rounded-md border border-border bg-surface-2 px-4 font-mono text-[12px] text-fg transition-colors hover:border-border-strong hover:bg-surface-3 md:text-[14px]"
    >
      <span className="text-muted" aria-hidden="true">
        $
      </span>
      <code className="truncate">{command}</code>
      {copied ? (
        <svg
          className="h-3.5 w-3.5 shrink-0 text-success"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="m3 8.5 3 3 7-7"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg
          className="h-3.5 w-3.5 shrink-0 text-muted"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <rect x="5.25" y="5.25" width="7.5" height="7.5" rx="1.25" stroke="currentColor" />
          <path
            d="M10.5 5.25V4.5A1.25 1.25 0 0 0 9.25 3.25H4.5A1.25 1.25 0 0 0 3.25 4.5v4.75A1.25 1.25 0 0 0 4.5 10.5h.75"
            stroke="currentColor"
          />
        </svg>
      )}
    </button>
  );
}

const HERO_SLACK_MESSAGES = [
  {
    id: "review",
    emoji: "⌛",
    status: "Waiting on PR review",
    title: "Onboarding advance jobs stuck up to 24h after retry exhaustion",
    time: "10:01 AM",
    body: (
      <>
        The pg-boss queue alert fired because a <SlackCode>growth.onboarding.advance</SlackCode> job
        from July 25 08:00 was revived by the daily reconciliation on July 26 08:00, appearing 24h
        old in the <SlackCode>oldest_pending_age_ms</SlackCode> metric and spiking the cross-queue
        average to ~976K ms. The underlying defect is that the only recovery mechanism is the
        once-daily <SlackCode>growth.onboarding.scan</SlackCode> cron at 8 AM UTC, so exhausted jobs
        can be delayed by up to ~24 hours before onboarding resumes.
      </>
    ),
  },
  {
    id: "ready",
    emoji: "🔀",
    status: "PR ready to merge",
    title: "Prevent duplicate Stripe charges after worker lock timeouts",
    time: "10:07 AM",
    body: (
      <>
        Superlog traced duplicate charges to <SlackCode>billing.webhook.process</SlackCode> retrying
        after <SlackCode>lock_timeout_ms</SlackCode> while the first attempt was still committing.
        The PR records <SlackCode>stripe_event_id</SlackCode> before dispatch, adds an idempotency
        guard at the application boundary, and includes a concurrency regression test. Production
        replay now shows one charge per event.
      </>
    ),
  },
  {
    id: "resolved",
    emoji: "✅",
    status: "Problem resolved",
    title: "Checkout recovered after Stripe credential validation fix",
    time: "10:14 AM",
    body: (
      <>
        Deploy <SlackCode>api-2026.07.28.3</SlackCode> added startup validation for{" "}
        <SlackCode>STRIPE_SECRET_KEY</SlackCode>, replaced the generic HTTP 400 with an actionable
        configuration error, and added a health check for <SlackCode>checkout-api</SlackCode>. Error
        rate returned to baseline within three minutes, and no failed payments remain in the current
        window.
      </>
    ),
  },
] as const;

function SlackCode({ children }: { children: string }) {
  return (
    <code className="whitespace-nowrap rounded-[4px] border border-[#d9d9d9] bg-[#f7f7f7] px-[5px] py-px font-mono text-[11px] not-italic leading-4 text-[#e01e5a]">
      {children}
    </code>
  );
}

function HeroSlackMessage() {
  const [activeMessageIndex, setActiveMessageIndex] = useState(0);
  const message = HERO_SLACK_MESSAGES[activeMessageIndex] ?? HERO_SLACK_MESSAGES[0];
  const secondaryAction =
    "inline-flex shrink-0 items-center gap-1 rounded-[4px] border border-black/30 bg-white px-[7px] py-[5px] text-[12px] font-bold leading-[17px] text-[#1d1c1d] transition-colors hover:bg-black/[0.04]";

  return (
    <div className="landing-slack-card w-full max-w-[660px]">
      <div className="landing-slack-float relative w-full">
        <div
          aria-hidden="true"
          className="landing-slack-card-back landing-slack-card-back-two absolute inset-0 rounded-lg"
        />
        <div
          aria-hidden="true"
          className="landing-slack-card-back landing-slack-card-back-one absolute inset-0 rounded-lg"
        />

        <div
          className="landing-slack-shuffle-card relative z-10 overflow-hidden rounded-lg border border-black/10 bg-white text-[#1d1c1d] shadow-[0_28px_90px_rgba(0,0,0,0.42)]"
          onAnimationIteration={() =>
            setActiveMessageIndex((index) => (index + 1) % HERO_SLACK_MESSAGES.length)
          }
        >
          <div className="flex min-h-[269px] items-start gap-3.5 px-4 py-6 sm:px-5 lg:px-[26px]">
            <div className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-[10px] border border-black/[0.08] bg-white">
              <img
                src="/superlog-pictogram-dark.svg"
                alt=""
                aria-hidden="true"
                className="h-[18px] w-[18px]"
              />
            </div>

            <div className="flex min-w-0 flex-1 self-stretch flex-col">
              <div className="flex flex-wrap items-center gap-[9px] pb-2.5">
                <span className="text-[15px] font-bold leading-5">Superlog</span>
                <span className="rounded-sm bg-[#eeeeee] px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-[14px] tracking-[0.04em] text-[#454245]">
                  app
                </span>
                <span className="text-[12px] leading-4 text-[#616061]">{message.time}</span>
              </div>

              <div className="pb-2.5">
                <div className="flex items-center gap-[9px]">
                  <span
                    aria-hidden="true"
                    className="w-4 shrink-0 font-['Apple_Color_Emoji'] text-[16px] leading-[18px]"
                  >
                    {message.emoji}
                  </span>
                  <span className="text-[16px] font-bold leading-[22px]">{message.status}</span>
                </div>
                <h2 className="mt-[5px] text-[14px] font-semibold leading-[21px]">
                  {message.title}
                </h2>
              </div>

              <p className="pb-3.5 text-[11.5px] italic leading-[18px] tracking-[-0.005em] text-[#2a282a]">
                {message.body}
              </p>

              <div className="mt-auto flex flex-wrap items-center gap-1.5">
                <button type="button" className={secondaryAction}>
                  Open in Superlog
                </button>
                <button type="button" className={secondaryAction}>
                  View PR
                </button>
                <button
                  type="button"
                  className="inline-flex shrink-0 items-center gap-1 rounded-[4px] bg-[#007a5a] px-[7px] py-[5px] text-[12px] font-bold leading-[17px] text-white transition-colors hover:bg-[#006b4f]"
                >
                  <span aria-hidden="true" className="font-['Apple_Color_Emoji'] text-[14px]">
                    🔀
                  </span>
                  Merge PR
                </button>
                <button type="button" className={secondaryAction}>
                  <span aria-hidden="true" className="font-['Apple_Color_Emoji'] text-[14px]">
                    ✅
                  </span>
                  Problem resolved
                </button>
                <button type="button" className={secondaryAction}>
                  <span aria-hidden="true" className="font-['Apple_Color_Emoji'] text-[14px]">
                    🔕
                  </span>
                  Not an issue
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
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
        src="/observability-motion.webp"
        srcSet="/observability-motion-768.webp 768w, /observability-motion-1600.webp 1600w, /observability-motion.webp 3024w"
        sizes="(max-width: 768px) 100vw, 1400px"
        alt=""
        aria-hidden="true"
        width={3024}
        height={3780}
        loading="lazy"
        decoding="async"
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
          src="/observability-drift.webp"
          srcSet="/observability-drift-768.webp 768w, /observability-drift-1600.webp 1600w, /observability-drift.webp 5304w"
          sizes="(min-width: 1024px) 50vw, 100vw"
          alt=""
          aria-hidden="true"
          width={5304}
          height={7952}
          loading="lazy"
          decoding="async"
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
          src="/fix-bugs-motion.webp"
          srcSet="/fix-bugs-motion-768.webp 768w, /fix-bugs-motion.webp 1536w"
          sizes="(min-width: 1024px) 50vw, 100vw"
          alt=""
          aria-hidden="true"
          width={1536}
          height={1024}
          loading="lazy"
          decoding="async"
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
          src="/zero-clicks-motion.webp"
          srcSet="/zero-clicks-motion-768.webp 768w, /zero-clicks-motion.webp 1122w"
          sizes="(max-width: 768px) 100vw, 1400px"
          alt=""
          aria-hidden="true"
          width={1122}
          height={1402}
          loading="lazy"
          decoding="async"
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
          src="/no-lock-in-motion.webp"
          srcSet="/no-lock-in-motion-768.webp 768w, /no-lock-in-motion-1600.webp 1600w, /no-lock-in-motion.webp 3024w"
          sizes="(max-width: 768px) 100vw, 1400px"
          alt=""
          aria-hidden="true"
          width={3024}
          height={3024}
          loading="lazy"
          decoding="async"
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
            window.location.href = "/app";
          }}
        />
      </div>
    </dialog>
  );
}
