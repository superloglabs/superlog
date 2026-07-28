import { usePostHog } from "posthog-js/react";
import { useEffect, useRef, useState } from "react";
import { AuthForm } from "./AuthForm.tsx";
import { FluidSignalField } from "./FluidSignalField.tsx";
import { Arrow, Btn, Label, Wordmark } from "./design/ui.tsx";
import { formatStarCount } from "./githubStars.ts";
import { INSTALL_PROMPT } from "./installPrompt.ts";
import { LANDING_DOCS_URL, LANDING_GITHUB_REPO_URL } from "./landingLinks.ts";
import {
  CloudflareIcon,
  GcpIcon,
  SentryIcon,
  VercelIcon,
} from "./onboarding/icons.tsx";
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

        <div className="mx-auto w-full max-w-[1400px] px-0 pb-24 md:px-8 xl:px-12">
          <ErrorImportSection />

          <AgentContextSection />

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
              <span className="tabular-nums">
                {stars != null ? formatStarCount(stars) : "GitHub"}
              </span>
            </a>
            <Btn variant="ghost" size="sm" onClick={onSignIn}>
              <span className="landing-nav-unblur" style={{ animationDelay: "485ms" }}>
                Sign in
              </span>
            </Btn>
            <span className="landing-nav-unblur inline-flex" style={{ animationDelay: "540ms" }}>
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
    <section className="relative flex min-h-[640px] flex-col overflow-hidden bg-bg lg:min-h-[calc(88svh-64px)]">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-0 h-full w-[min(3200px,220vw)] -translate-x-1/2 overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_3%,black_97%,transparent)] [-webkit-mask-image:linear-gradient(to_right,transparent,black_3%,black_97%,transparent)]">
          <FluidSignalField />
        </div>
        <div className="landing-fluid-hero-overlay absolute inset-0" />
      </div>

      <div className="relative mx-auto grid w-full max-w-[1400px] flex-1 items-center gap-8 px-4 py-8 md:px-8 md:py-10 lg:grid-cols-[minmax(0,560px)_minmax(0,1fr)] lg:gap-12 xl:px-12">
        <div className="flex flex-col items-center text-center lg:items-start lg:text-left">
          <div
            className="landing-hero-unblur mb-5 inline-flex items-center gap-2 text-[11px] font-medium text-muted md:text-[12px]"
            style={{ animationDelay: "180ms" }}
          >
            <img src="/yc-logo-square.svg" alt="" aria-hidden="true" className="h-4 w-4" />
            <span>Backed by Y Combinator</span>
          </div>
          <h1
            className="landing-hero-unblur max-w-[410px] text-balance text-[2.4375rem] leading-[0.98] tracking-[-0.035em] text-fg md:text-[57px] md:leading-[56px]"
            style={{ fontWeight: 450, animationDelay: "260ms" }}
          >
            Fix bugs on autopilot
          </h1>
          <p
            className="landing-hero-unblur mt-4 max-w-lg text-[13.5px] leading-relaxed text-muted md:text-[18px]"
            style={{ animationDelay: "340ms" }}
          >
            Connect your app and get PRs with fixes in Slack
          </p>
          <div
            className="landing-hero-unblur mt-6 flex flex-col items-center gap-3 sm:flex-row lg:items-start"
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

      <ClientLogos />
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
    <section aria-label="Trusted by teams" className="relative pb-5 md:pb-6">
      <div className="mx-auto w-full max-w-[1400px] px-4 md:px-8 xl:px-12">
        <p className="mb-4 text-center text-[11px] font-medium uppercase tracking-[0.2em] text-subtle md:mb-5 md:text-[12px]">
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
    title: "Fix checkout crash when the promo code is empty",
    time: "10:01 AM",
    body: (
      <>
        Superlog traced failed checkouts to a missing empty-value check when a customer submits
        without a promo code.
        <br />
        This PR adds a safe fallback and a test that confirms checkout completes with or without a
        code.
      </>
    ),
  },
  {
    id: "noise",
    emoji: "🔕",
    status: "Marked as noise",
    title: "Browser extension errors aren't affecting your app",
    time: "10:07 AM",
    body: (
      <>
        These errors came from a browser extension injecting a script into the page, not from your
        application code.
        <br />
        No customers were blocked. Superlog marked the pattern as noise so future occurrences won't
        alert the team.
      </>
    ),
  },
  {
    id: "resolved",
    emoji: "✅",
    status: "Problem resolved",
    title: "Email delivery recovered after a brief provider slowdown",
    time: "10:14 AM",
    body: "Password reset emails were delayed for four minutes while the email provider was responding slowly. Delivery returned to normal, all queued emails were sent, and no code or configuration change was needed. Superlog closed the incident automatically.",
  },
] as const;

function HeroSlackMessage() {
  const [activeMessageIndex, setActiveMessageIndex] = useState(0);
  const message = HERO_SLACK_MESSAGES[activeMessageIndex] ?? HERO_SLACK_MESSAGES[0];
  const secondaryAction =
    "inline-flex shrink-0 items-center gap-1 rounded-[4px] border border-black/30 bg-white px-[7px] py-[5px] text-[12px] font-bold leading-[17px] text-[#1d1c1d]";

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

              <p className="pb-3.5 text-[14px] italic leading-[21px] tracking-[-0.005em] text-[#2a282a]">
                {message.body}
              </p>

              <div className="mt-auto flex flex-wrap items-center gap-1.5">
                <span className={secondaryAction}>
                  {message.id === "noise" ? "Open incident in Superlog" : "Open in Superlog"}
                </span>
                {message.id === "review" && (
                  <>
                    <span className={secondaryAction}>View PR</span>
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-[4px] bg-[#007a5a] px-[7px] py-[5px] text-[12px] font-bold leading-[17px] text-white">
                      <span aria-hidden="true" className="font-['Apple_Color_Emoji'] text-[14px]">
                        🔀
                      </span>
                      Merge PR
                    </span>
                  </>
                )}
                {message.id === "resolved" && (
                  <span className={secondaryAction}>View timeline</span>
                )}
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
    <section id={id} className={`${id === "install" ? "mt-28" : "mt-24"} scroll-mt-24`}>
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

const ERROR_IMPORT_CARDS = [
  { title: "Checkout timeout", detail: "12 events · 3 services" },
  { title: "Database connection failed", detail: "8 events · 2 services" },
  { title: "Payment webhook error", detail: "5 events · 1 service" },
] as const;

function ErrorImportSection() {
  const [activeErrorIndex, setActiveErrorIndex] = useState(0);
  const activeError = ERROR_IMPORT_CARDS[activeErrorIndex] ?? ERROR_IMPORT_CARDS[0];

  return (
    <section id="errors" className="mt-24 scroll-mt-24">
      <header className="grid grid-cols-1 gap-3 px-4 text-center md:px-0 lg:grid-cols-12 lg:items-end lg:gap-x-6 lg:text-left">
        <h2 className="mx-auto text-balance text-[28px] font-semibold tracking-tight text-fg md:text-[32px] lg:col-span-6 lg:mx-0 lg:text-[36px] lg:leading-none">
          Connect to any platform
        </h2>
        <p className="mx-auto max-w-3xl text-sm leading-relaxed text-muted lg:col-span-5 lg:col-start-8 lg:mx-0 lg:max-w-none lg:text-[18px] lg:leading-7">
          Import errors from Sentry, connect debugging MCPs like Datadog, or take logs directly
          from your infrastructure provider
        </p>
      </header>

      <div
        className="relative mt-16 min-h-[640px] overflow-hidden sm:min-h-[572px] md:mt-[72px]"
      >
        <div aria-hidden="true" className="error-import-grid error-import-grid-fade absolute inset-0" />

        <div aria-hidden="true" className="error-import-line error-import-line-from-source error-import-line-top absolute left-[calc(20%+16px)] top-[20%] h-[30%] w-[calc(30%-16px)] rounded-tr-[32px] border-r-[1.5px] border-t-[1.5px] sm:left-[calc(16%+16px)] sm:w-[calc(34%-16px)] md:left-[16%] md:w-[34%] lg:left-[15%] lg:w-[35%]" />
        <div aria-hidden="true" className="error-import-line error-import-line-from-source error-import-line-middle absolute left-[calc(20%+16px)] top-1/2 w-[calc(30%-16px)] border-t-[1.5px] sm:left-[calc(16%+16px)] sm:w-[calc(34%-16px)] md:left-[16%] md:w-[34%] lg:left-[15%] lg:w-[35%]" />
        <div aria-hidden="true" className="error-import-line error-import-line-from-source error-import-line-bottom absolute left-[calc(20%+16px)] top-1/2 h-[30%] w-[calc(30%-16px)] rounded-br-[32px] border-b-[1.5px] border-r-[1.5px] sm:left-[calc(16%+16px)] sm:w-[calc(34%-16px)] md:left-[16%] md:w-[34%] lg:left-[15%] lg:w-[35%]" />
        <div aria-hidden="true" className="error-import-line error-import-line-to-destination absolute left-1/2 top-1/2 w-[27%] border-t-[1.5px] sm:w-[30%] lg:w-[29%]" />
        <span aria-hidden="true" className="error-import-particle error-import-particle-top" />
        <span aria-hidden="true" className="error-import-particle error-import-particle-middle" />
        <span aria-hidden="true" className="error-import-particle error-import-particle-bottom" />

        <ProviderGroup
          className="top-[20%] -translate-y-1/2"
          name="Observability platforms"
          detail="Import errors from Sentry and add debugging context through MCPs like Datadog"
          copyClassName="lg:max-w-[68%]"
        >
          <div className="flex items-center gap-1.5">
            <ProviderMark label="Datadog" className="!bg-white text-[#632ca6]">
              <DatadogMark />
            </ProviderMark>
            <ProviderMark label="Sentry" className="text-[#d8cfff]">
              <SentryIcon size={19} />
            </ProviderMark>
          </div>
        </ProviderGroup>

        <ProviderGroup
          className="top-1/2 -translate-y-1/2"
          name="Infrastructure"
          detail="Import logs and metrics."
          supportingText="We support AWS, GCP, Cloudflare, Vercel, Render, Railway and more"
        >
          <div className="flex items-center -space-x-1.5">
            <ProviderMark label="AWS" className="!bg-white text-[#ff9900]">
              <img src="/aws-logo.svg" alt="" aria-hidden="true" className="h-[21px] w-[21px]" />
            </ProviderMark>
            <ProviderMark label="Google Cloud" className="text-[#4285f4]">
              <GcpIcon size={18} />
            </ProviderMark>
            <ProviderMark label="Cloudflare" className="text-[#f48120]">
              <CloudflareIcon size={18} />
            </ProviderMark>
            <ProviderMark label="Vercel" className="text-fg">
              <VercelIcon size={16} />
            </ProviderMark>
          </div>
        </ProviderGroup>

        <ProviderGroup
          className="top-[80%] -translate-y-1/2"
          name="Integrate any app"
          detail="Send logs, traces and metrics to Superlog using OpenTelemetry"
        />

        <div className="absolute right-[5%] top-1/2 flex w-[36%] -translate-y-1/2 items-center justify-center rounded-lg border border-fg/65 bg-bg/95 px-4 py-7 sm:right-[6%] sm:w-[28%] md:px-5 lg:right-[8%] lg:w-[26%]">
          <span className="flex max-w-full items-center [&>img]:h-auto [&>img]:max-h-6 [&>img]:max-w-full">
            <Wordmark />
          </span>
        </div>

        <div className="absolute right-[5%] top-[calc(50%+58px)] w-[36%] sm:right-[6%] sm:w-[28%] lg:right-[8%] lg:w-[26%]">
          <div className="text-[9px] font-medium uppercase tracking-[0.16em] text-muted">
            Errors ready to fix
          </div>
          <div className="relative mt-3 h-[88px]">
            <div
              aria-hidden="true"
              className="error-stack-card-back error-stack-card-back-two absolute inset-x-0 top-0 h-[62px] rounded-md border border-border-strong bg-bg/95"
            />
            <div
              aria-hidden="true"
              className="error-stack-card-back error-stack-card-back-one absolute inset-x-0 top-0 h-[62px] rounded-md border border-border-strong bg-bg/95"
            />
            <div
              className="error-stack-shuffle-card relative z-10 min-h-[62px] rounded-md border border-border-strong bg-bg/95 px-3 py-3"
              onAnimationIteration={() =>
                setActiveErrorIndex((index) => (index + 1) % ERROR_IMPORT_CARDS.length)
              }
            >
              <div className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />
                <span className="truncate text-[10px] font-medium text-fg md:text-[11px]">
                  {activeError.title}
                </span>
              </div>
              <div className="mt-1.5 pl-3.5 text-[9px] text-muted">{activeError.detail}</div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function ProviderGroup({
  className,
  name,
  detail,
  supportingText,
  copyClassName = "",
  children,
}: {
  className: string;
  name: string;
  detail: string;
  supportingText?: string;
  copyClassName?: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={`absolute left-4 w-[40%] rounded-lg border border-border-strong bg-bg/95 p-4 sm:w-[32%] md:left-0 md:p-5 lg:w-[30%] ${className}`}
    >
      <div className="flex flex-col items-start gap-3 lg:flex-row lg:items-center lg:justify-between lg:gap-2">
        <div className={`min-w-0 ${copyClassName}`}>
          <div className="text-[14px] font-semibold leading-tight text-fg md:text-[17px]">{name}</div>
          <div className="mt-1 text-[10px] leading-[15px] text-muted md:text-[13px] md:leading-[18px]">
            {detail}
          </div>
          {supportingText && (
            <div className="mt-1.5 text-[10px] leading-[15px] text-muted md:text-[13px] md:leading-[18px]">
              {supportingText}
            </div>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

function ProviderMark({
  label,
  className,
  children,
}: {
  label: string;
  className: string;
  children: React.ReactNode;
}) {
  return (
    <span
      title={label}
      className={`flex h-9 w-9 items-center justify-center rounded-full border border-border-strong bg-surface ${className} md:h-10 md:w-10`}
    >
      {children}
    </span>
  );
}

function DatadogMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-6 w-6 fill-current">
      <path d="M19.57 17.04l-1.997-1.316-1.665 2.782-1.937-.567-1.706 2.604.087.82 9.274-1.71-.538-5.794zm-8.649-2.498l1.488-.204c.241.108.409.15.697.223.45.117.97.23 1.741-.16.18-.088.553-.43.704-.625l6.096-1.106.622 7.527-10.444 1.882zm11.325-2.712l-.602.115L20.488 0 .789 2.285l2.427 19.693 2.306-.334c-.184-.263-.471-.581-.96-.989-.68-.564-.44-1.522-.039-2.127.53-1.022 3.26-2.322 3.106-3.956-.056-.594-.15-1.368-.702-1.898-.02.22.017.432.017.432s-.227-.289-.34-.683c-.112-.15-.2-.199-.319-.4-.085.233-.073.503-.073.503s-.186-.437-.216-.807c-.11.166-.137.48-.137.48s-.241-.69-.186-1.062c-.11-.323-.436-.965-.343-2.424.6.421 1.924.321 2.44-.439.171-.251.288-.939-.086-2.293-.24-.868-.835-2.16-1.066-2.651l-.028.02c.122.395.374 1.223.47 1.625.293 1.218.372 1.642.234 2.204-.116.488-.397.808-1.107 1.165-.71.358-1.653-.514-1.713-.562-.69-.55-1.224-1.447-1.284-1.883-.062-.477.275-.763.445-1.153-.243.07-.514.192-.514.192s.323-.334.722-.624c.165-.109.262-.178.436-.323a9.762 9.762 0 0 0-.456.003s.42-.227.855-.392c-.318-.014-.623-.003-.623-.003s.937-.419 1.678-.727c.509-.208 1.006-.147 1.286.257.367.53.752.817 1.569.996.501-.223.653-.337 1.284-.509.554-.61.99-.688.99-.688s-.216.198-.274.51c.314-.249.66-.455.66-.455s-.134.164-.259.426l.03.043c.366-.22.797-.394.797-.394s-.123.156-.268.358c.277-.002.838.012 1.056.037 1.285.028 1.552-1.374 2.045-1.55.618-.22.894-.353 1.947.68.903.888 1.609 2.477 1.259 2.833-.294.295-.874-.115-1.516-.916a3.466 3.466 0 0 1-.716-1.562 1.533 1.533 0 0 0-.497-.85s.23.51.23.96c0 .246.03 1.165.424 1.68-.039.076-.057.374-.1.43-.458-.554-1.443-.95-1.604-1.067.544.445 1.793 1.468 2.273 2.449.453.927.186 1.777.416 1.997.065.063.976 1.197 1.15 1.767.306.994.019 2.038-.381 2.685l-1.117.174c-.163-.045-.273-.068-.42-.153.08-.143.241-.5.243-.572l-.063-.111c-.348.492-.93.97-1.414 1.245-.633.359-1.363.304-1.838.156-1.348-.415-2.623-1.327-2.93-1.566 0 0-.01.191.048.234.34.383 1.119 1.077 1.872 1.56l-1.605.177.759 5.908c-.337.048-.39.071-.757.124-.325-1.147-.946-1.895-1.624-2.332-.599-.384-1.424-.47-2.214-.314l-.05.059a2.851 2.851 0 0 1 1.863.444c.654.413 1.181 1.481 1.375 2.124.248.822.42 1.7-.248 2.632-.476.662-1.864 1.028-2.986.237.3.481.705.876 1.25.95.809.11 1.577-.03 2.106-.574.452-.464.69-1.434.628-2.456l.714-.104.258 1.834 11.827-1.424zM15.05 6.848c-.034.075-.085.125-.007.37l.004.014.013.032.032.073c.14.287.295.558.552.696.067-.011.136-.019.207-.023.242-.01.395.028.492.08.009-.048.01-.119.005-.222-.018-.364.072-.982-.626-1.308-.264-.122-.634-.084-.757.068a.302.302 0 0 1 .058.013c.186.066.06.13.027.207m1.958 3.392c-.092-.05-.52-.03-.821.005-.574.068-1.193.267-1.328.372-.247.191-.135.523.047.66.511.382.96.638 1.432.575.29-.038.546-.497.728-.914.124-.288.124-.598-.058-.698m-5.077-2.942c.162-.154-.805-.355-1.556.156-.554.378-.571 1.187-.041 1.646.053.046.096.078.137.104a4.77 4.77 0 0 1 1.396-.412c.113-.125.243-.345.21-.745-.044-.542-.455-.456-.146-.749" />
    </svg>
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

// ---------------------------------------------------------------------------
// Agent context — the sources and feedback loop behind higher-quality fixes.
// ---------------------------------------------------------------------------

function AgentContextSection() {
  return (
    <section id="context" className="mt-28 scroll-mt-24">
      <header className="px-4 md:px-0">
        <h2 className="text-[28px] font-semibold tracking-tight text-fg md:text-[32px] lg:text-[36px] lg:leading-none">
          Full context for your agent
        </h2>
      </header>

      <div className="mt-14 grid gap-y-12 md:grid-cols-3 md:gap-y-0">
        <AgentContextTile
          illustration={<ContextSourcesIllustration />}
          title="Custom context for your fixes."
          body="Add custom MCPs, your Notion knowledge base, and Linear tickets to help the agent produce perfect fixes."
          position="first"
        />
        <AgentContextTile
          illustration={<MemoryIllustration />}
          title="Memory system."
          body="Every comment and review on Superlog PRs improves accuracy and quality."
          position="middle"
        />
        <AgentContextTile
          illustration={<PullRequestIllustration />}
          title="PR autopilot."
          body="Superlog follows up on PRs, passes them through review, and addresses your comments."
          position="last"
        />
      </div>
    </section>
  );
}

function AgentContextTile({
  illustration,
  title,
  body,
  position,
}: {
  illustration: React.ReactNode;
  title: string;
  body: string;
  position: "first" | "middle" | "last";
}) {
  const desktopBorder =
    position === "first"
      ? "md:rounded-l-xl md:rounded-r-none"
      : position === "last"
        ? "md:-ml-px md:rounded-l-none md:rounded-r-xl"
        : "md:-ml-px md:rounded-none";

  return (
    <article className="min-w-0">
      <div
        className={`relative flex h-[350px] items-center justify-center overflow-hidden rounded-xl border border-border bg-bg ${desktopBorder}`}
      >
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-[radial-gradient(circle_at_50%_48%,rgba(255,255,255,0.045),transparent_58%)]"
        />
        {illustration}
      </div>
      <p className="px-4 pt-6 text-[17px] leading-[1.55] md:px-5 lg:px-6 lg:text-[18px]">
        <strong className="font-semibold text-fg">{title}</strong>{" "}
        <span className="text-muted">{body}</span>
      </p>
    </article>
  );
}

const CONTEXT_SOURCES = [
  { label: "Notion", icon: "notion" },
  { label: "Linear", icon: "linear" },
  { label: "GitHub", icon: "github" },
  { label: "AGENTS.md", icon: "file" },
  { label: "CLAUDE.md", icon: "file" },
  { label: "Custom prompt", icon: "prompt" },
  { label: "Custom MCP", icon: "mcp" },
] as const;

function ContextSourcesIllustration() {
  const rows = [
    CONTEXT_SOURCES.slice(0, 4),
    [...CONTEXT_SOURCES.slice(4), CONTEXT_SOURCES[0]],
    CONTEXT_SOURCES.slice(2, 6),
    [CONTEXT_SOURCES[6], ...CONTEXT_SOURCES.slice(0, 3)],
    CONTEXT_SOURCES.slice(1, 5),
    CONTEXT_SOURCES.slice(3, 7),
    [...CONTEXT_SOURCES.slice(5), ...CONTEXT_SOURCES.slice(0, 2)],
  ];

  return (
    <div className="relative z-10 grid w-full gap-3 overflow-hidden" aria-hidden="true">
      {rows.map((row, rowIndex) => (
        <div
          key={row.map((source) => source.label).join("-")}
          className={`context-pill-track flex w-max ${rowIndex % 2 === 1 ? "context-pill-track-reverse" : ""}`}
        >
          {[0, 1].map((copy) => (
            <div
              key={`${rowIndex}-${copy}`}
              aria-hidden={copy === 1 || undefined}
              className="flex shrink-0 gap-3 pr-3"
            >
              {row.map((source) => (
                <ContextSourcePill
                  key={`${copy}-${source.label}`}
                  label={source.label}
                  icon={source.icon}
                />
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function ContextSourcePill({
  label,
  icon,
}: {
  label: string;
  icon: (typeof CONTEXT_SOURCES)[number]["icon"];
}) {
  return (
    <span className="inline-flex h-12 shrink-0 items-center gap-2.5 rounded-full border border-border-strong bg-surface/80 px-4 text-[14px] font-medium text-fg shadow-[0_14px_36px_rgba(0,0,0,0.28)] backdrop-blur">
      <ContextSourceIcon kind={icon} />
      {label}
    </span>
  );
}

function ContextSourceIcon({
  kind,
}: {
  kind: (typeof CONTEXT_SOURCES)[number]["icon"];
}) {
  if (kind === "github") {
    return <GitHubIcon />;
  }

  if (kind === "notion") {
    return (
      <span className="flex h-5 w-5 items-center justify-center rounded-[3px] border border-fg/60 font-serif text-[11px] font-bold leading-none">
        N
      </span>
    );
  }

  if (kind === "linear") {
    return (
      <svg className="h-5 w-5" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path d="M4.1 3.85a8.35 8.35 0 0 1 12.05 12.04L4.1 3.85Z" fill="currentColor" />
        <path d="m3.1 6.2 10.7 10.7M2.25 9.05l8.7 8.7M2.7 12.9l4.4 4.4" stroke="currentColor" />
      </svg>
    );
  }

  if (kind === "file") {
    return (
      <svg className="h-5 w-5" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path d="M5.25 2.5h6l3.5 3.5v11.5h-9.5V2.5Z" stroke="currentColor" strokeWidth="1.25" />
        <path d="M11.25 2.75V6h3.25M7.5 9h5M7.5 12h5" stroke="currentColor" />
      </svg>
    );
  }

  if (kind === "prompt") {
    return (
      <svg className="h-5 w-5" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path
          d="M10 2.5c.4 3.25 2.25 5.1 5.5 5.5-3.25.4-5.1 2.25-5.5 5.5C9.6 10.25 7.75 8.4 4.5 8 7.75 7.6 9.6 5.75 10 2.5Z"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeLinejoin="round"
        />
        <path
          d="M15.25 12.25c.18 1.42 1.08 2.32 2.5 2.5-1.42.18-2.32 1.08-2.5 2.5-.18-1.42-1.08-2.32-2.5-2.5 1.42-.18 2.32-1.08 2.5-2.5Z"
          fill="currentColor"
        />
      </svg>
    );
  }

  return (
    <svg className="h-5 w-5" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="5" cy="5" r="2" stroke="currentColor" />
      <circle cx="15" cy="5" r="2" stroke="currentColor" />
      <circle cx="10" cy="15" r="2" stroke="currentColor" />
      <path d="m6.75 6 2.1 6.9M13.25 6l-2.1 6.9M7 5h6" stroke="currentColor" />
    </svg>
  );
}

function MemoryIllustration() {
  const nodes = [
    { x: 54, y: 52, dot: true },
    { x: 115, y: 42, dot: true },
    { x: 163, y: 76, dot: true },
    { x: 220, y: -18, dot: false },
    { x: 277, y: 56, dot: true },
    { x: 358, y: 72, dot: true },
    { x: 458, y: 116, dot: false },
    { x: 374, y: 175, dot: true },
    { x: 458, y: 265, dot: false },
    { x: 347, y: 286, dot: true },
    { x: 274, y: 264, dot: true },
    { x: 236, y: 316, dot: true },
    { x: 184, y: 279, dot: true },
    { x: 118, y: 304, dot: true },
    { x: -18, y: 285, dot: false },
    { x: 62, y: 238, dot: true },
    { x: 28, y: 175, dot: true },
    { x: -18, y: 94, dot: false },
    { x: 102, y: 104, dot: true },
  ];

  return (
    <div className="relative z-10 h-full w-full text-fg" aria-hidden="true">
      <svg
        className="h-full w-full"
        viewBox="0 0 440 350"
        fill="none"
        preserveAspectRatio="xMidYMid slice"
        aria-hidden="true"
      >
        <defs>
          <filter id="memory-pulse-streak" x="-80%" y="-200%" width="260%" height="500%">
            <feGaussianBlur stdDeviation=".8 .35" />
          </filter>
        </defs>

        {nodes.map((node, index) => (
          <g key={`${node.x}-${node.y}`}>
            <line
              x1="220"
              y1="175"
              x2={node.x}
              y2={node.y}
              stroke="currentColor"
              strokeOpacity=".14"
              strokeWidth="1"
            />
            <ellipse
              className="memory-spoke-pulse"
              cx="0"
              cy="0"
              rx="3"
              ry="1.2"
              fill="currentColor"
              opacity="0"
              filter="url(#memory-pulse-streak)"
              style={
                {
                  "--memory-pulse-x": `${node.x}px`,
                  "--memory-pulse-y": `${node.y}px`,
                  "--memory-pulse-angle": `${(Math.atan2(175 - node.y, 220 - node.x) * 180) / Math.PI}deg`,
                  animationDelay: `${((index * 7) % nodes.length) * 0.31}s`,
                  animationDuration: `${5.6 + (index % 4) * 0.7}s`,
                } as React.CSSProperties
              }
            />
            {node.dot && (
              <>
                <circle
                  className="memory-terminal-glow"
                  cx={node.x}
                  cy={node.y}
                  r="7"
                  fill="currentColor"
                  style={{
                    animationDelay: `${index * -0.43}s`,
                    animationDuration: `${3.8 + (index % 5) * 0.55}s`,
                  }}
                />
                <circle cx={node.x} cy={node.y} r="3" fill="currentColor" />
              </>
            )}
          </g>
        ))}

        <circle cx="220" cy="175" r="4" fill="currentColor" />
      </svg>
    </div>
  );
}

function PullRequestIllustration() {
  return (
    <div className="relative z-10 w-[90%] max-w-[410px] translate-x-[7%] rounded-xl border border-border-strong bg-bg/85 text-fg shadow-[0_26px_70px_rgba(0,0,0,0.42)] backdrop-blur">
      <div className="flex items-start gap-3 border-b border-border px-4 py-4">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-[3px] border-success">
          <span className="h-2.5 w-2.5 rounded-full bg-bg" />
        </span>
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold">All checks have passed</div>
          <div className="mt-0.5 text-[11px] text-muted">2 successful checks</div>
        </div>
      </div>

      <div className="space-y-3 bg-surface/70 px-4 py-4 text-[11px]">
        <div className="font-medium text-muted">2 successful checks</div>
        <div className="flex items-center gap-2">
          <span
            className="pr-check-appear text-[17px] leading-none text-success"
            style={{ animationDelay: "0ms" }}
          >
            ✓
          </span>
          <span className="flex h-5 w-5 items-center justify-center rounded bg-fg text-bg">
            <GitHubIcon />
          </span>
          <span className="min-w-0 flex-1 truncate text-[12px]">CI / Typecheck &amp; build</span>
          <span className="text-muted">Passed</span>
        </div>
        <div className="flex items-center gap-2">
          <span
            className="pr-check-appear text-[17px] leading-none text-success"
            style={{ animationDelay: "220ms" }}
          >
            ✓
          </span>
          <span className="flex h-5 w-5 items-center justify-center rounded border border-border-strong bg-surface-2">
            <img
              src="/superlog-pictogram-dark.svg"
              alt=""
              aria-hidden="true"
              className="h-3 w-3 invert"
            />
          </span>
          <span className="min-w-0 flex-1 truncate text-[12px]">Superlog / PR review</span>
          <span className="font-medium text-success">Approved</span>
        </div>
      </div>

      <div className="flex items-center gap-3 border-t border-border px-4 py-4">
        <span
          className="pr-check-appear flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-success text-[18px] font-semibold text-bg"
          style={{ animationDelay: "440ms" }}
        >
          ✓
        </span>
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold">Ready to merge</div>
          <div className="text-[11px] text-muted">No conflicts with base branch</div>
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
