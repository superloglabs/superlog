import { useQueryClient } from "@tanstack/react-query";
import { useCustomer } from "autumn-js/react";
import { usePostHog } from "posthog-js/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AcceptInvitation } from "./AcceptInvitation.tsx";
import { Activate } from "./Activate.tsx";
import { CommandPalette } from "./CommandPalette.tsx";
import { Explore } from "./Explore.tsx";
import { ForgotPassword } from "./ForgotPassword.tsx";
import { Issues } from "./Issues.tsx";
import { Landing } from "./Landing.tsx";
import { OauthConsent } from "./OauthConsent.tsx";
import { OrgProjectSwitcher } from "./OrgProjectSwitcher.tsx";
import { Overview } from "./Overview.tsx";
import { PrFeedback } from "./PrFeedback.tsx";
import { Pricing } from "./Pricing.tsx";
import { PrivacyPolicy } from "./PrivacyPolicy.tsx";
import { RailwayCallback } from "./RailwayCallback.tsx";
import { ResetPassword } from "./ResetPassword.tsx";
import { Settings } from "./Settings.tsx";
import { TermsOfService } from "./TermsOfService.tsx";
import { VercelCallback } from "./VercelCallback.tsx";
import { AlertEdit } from "./alerts/AlertEdit.tsx";
import { AlertsList } from "./alerts/AlertsList.tsx";
import { useMe } from "./api.ts";
import { authClient, useSession } from "./auth-client.ts";
import { signalAtHardCap } from "./billing.ts";
import { DashboardView } from "./dashboards/DashboardView.tsx";
import { DashboardsList } from "./dashboards/DashboardsList.tsx";
import { AppShell, ThemeToggle, Wordmark } from "./design/ui.tsx";
import { McpInstallPill } from "./onboarding/McpInstallPill.tsx";
import { OnboardingGate } from "./onboarding/OnboardingGate.tsx";
import { externalOAuthCallbackForwardUrl } from "./oauthCallbackForwarding.ts";
import { parseAttribution, persistFirstTouchAttribution } from "./signupAttribution.ts";
import { startSkillOnboarding } from "./skillOnboarding.ts";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4100";

function SignupSourceCapture() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const attr = parseAttribution(window.location.search, document.referrer);
    // The `?source=` tag is also forwarded to /api/me as a header and persisted
    // on orgs.signup_source, so keep its dedicated key untouched (see api.ts).
    if (attr.source) {
      try {
        const existing = window.localStorage.getItem("superlog.signup_source");
        if (!existing) window.localStorage.setItem("superlog.signup_source", attr.source);
      } catch {
        /* ignore */
      }
    }
    // Stash the full first-touch attribution (source + UTM + referrer) so the
    // PostHog signup event can report it once the user creates their first org.
    // landingPath is passed unconditionally on purpose: persistFirstTouchAttribution
    // only writes when there's real attribution signal (source/UTM/referrer) and
    // treats landingPath as ride-along context, so this can't lock in a
    // landingPath-only record on a plain pageview and shut out a later landing.
    persistFirstTouchAttribution(window.localStorage, {
      ...attr,
      landingPath: window.location.pathname,
    });
  }, []);
  return null;
}

function GithubInstallCallbackForwarder() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (!params.has("installation_id") || !params.has("state")) return;
    window.location.replace(`${API_URL}/github/install/callback${window.location.search}`);
  }, []);
  return null;
}

function ExternalOAuthCallbackForwarder() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = externalOAuthCallbackForwardUrl(window.location, API_URL);
    if (url) window.location.replace(url);
  }, []);
  return null;
}

function PostHogUserSync() {
  const { data, isPending } = useSession();
  const posthog = usePostHog();

  useEffect(() => {
    // `usePostHog()` returns the default (uninitialized) global instance when no
    // PostHogProvider is mounted (token unset), so this is a safety net rather
    // than a live crash path — guard anyway in case the return becomes nullable.
    if (!posthog || isPending) return;
    if (data?.user) {
      posthog.identify(data.user.id, {
        email: data.user.email,
        name: data.user.name,
      });
    } else {
      posthog.reset();
    }
  }, [isPending, data?.user, posthog]);

  return null;
}

function ActiveOrgSync() {
  const { data, isPending } = useSession();
  const queryClient = useQueryClient();
  const previous = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (isPending) return;
    const current = data?.session?.activeOrganizationId ?? null;
    if (previous.current === undefined) {
      previous.current = current;
      return;
    }
    if (previous.current !== current) {
      previous.current = current;
      queryClient.clear();
    }
  }, [isPending, data?.session?.activeOrganizationId, queryClient]);

  return null;
}

export function App() {
  return (
    <>
      <SignupSourceCapture />
      <GithubInstallCallbackForwarder />
      <ExternalOAuthCallbackForwarder />
      <PostHogUserSync />
      <ActiveOrgSync />
      <Routes>
        <Route path="/activate" element={<Activate />} />
        <Route path="/accept-invitation" element={<AcceptInvitation />} />
        <Route path="/oauth/consent" element={<OauthConsent />} />
        <Route path="/pricing" element={<Pricing />} />
        <Route path="/privacy" element={<PrivacyPolicy />} />
        <Route path="/tos" element={<TermsOfService />} />
        <Route path="/signup" element={<SignupRoute />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        {/* Public, no-auth feedback link reached from agent-opened PR descriptions. */}
        <Route path="/feedback/pr/:owner/:repo/:number" element={<PrFeedback />} />
        {/* Landing target of the Vercel OAuth callback — public so the result
            shows even when the callback lands in a fresh, gated, or logged-out
            tab (the install opens via window.open). */}
        <Route path="/connect/vercel" element={<VercelCallback />} />
        <Route path="/connect/railway" element={<RailwayCallback />} />
        <Route path="*" element={<AuthenticatedApp />} />
      </Routes>
    </>
  );
}

function SignupRoute() {
  const { data, isPending } = useSession();
  // The skill points users at /signup?from=skill. Stash the flag in
  // sessionStorage so it survives the auth handoff and OnboardingGate can
  // switch the normal onboarding UI into agent mode.
  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search);
    if (params.get("from") === "skill") {
      startSkillOnboarding(params.get("intent"));
    }
  }
  if (isPending) return null;
  if (data) return <Navigate to="/" replace />;
  return <Landing initialAuthMode="sign-up" />;
}

function AuthenticatedApp() {
  const { data, isPending } = useSession();
  const me = useMe();
  useGlobalKeybinds(!!data);
  const impersonating = me.data?.user.impersonating === true;
  // Billing top bar: a Free org that has exhausted a hard-capped signal has its
  // ingest paused — surface that app-wide with a prompt to add a card / switch
  // to pay-as-you-go. Reads the same Autumn balances as the billing page.
  const { check, data: billingCustomer } = useCustomer();
  const billingPaused =
    !impersonating &&
    !!billingCustomer &&
    // Only show the bar when blocking is actually enforced (metering can be on
    // without capping), so we never claim "Ingest paused" when it isn't.
    me.data?.billingEnforcement === true &&
    // Only the telemetry signals gate ingest. Investigation credits running out
    // doesn't pause ingest, so it must not trigger the "Ingest paused" bar.
    // signalAtHardCap swallows autumn-js check() throwing on a not-yet-hydrated
    // customer (e.g. a brand-new org) so billing state can't black-screen the app.
    ["spans", "logs", "metric_points"].some((f) => signalAtHardCap(check, f));
  if (isPending) return null;
  if (!data) return <Landing />;
  return (
    <OnboardingGate>
      <div className="flex min-h-screen flex-col bg-bg">
        {impersonating ? (
          <ImpersonationBar email={data.user.email} />
        ) : (
          billingPaused && <BillingLimitBar />
        )}
        <AppShell nav={<TopNav />}>
          <RouteContainer>
            <Routes>
              <Route path="/explore/*" element={<Explore />} />
              <Route path="/incidents" element={<Issues />} />
              <Route path="/incidents/:id" element={<Issues />} />
              <Route path="/issues" element={<Issues />} />
              <Route path="/issues/:id" element={<Issues />} />
              <Route path="/alerts" element={<AlertsList />} />
              <Route path="/alerts/new" element={<AlertEdit />} />
              <Route path="/alerts/:id" element={<AlertEdit />} />
              <Route path="/dashboards" element={<DashboardsList />} />
              <Route path="/dashboards/:id" element={<DashboardView />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<Overview />} />
            </Routes>
          </RouteContainer>
        </AppShell>
      </div>
      <CommandPalette />
      <McpInstallPill />
    </OnboardingGate>
  );
}

function useGlobalKeybinds(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    function handler(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      // ⌘K / Ctrl+K: open the command palette.
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        globalThis.__superlogPalette?.toggle();
        return;
      }
      // ⌘⇧P: stop impersonating from anywhere. ⌘⇧X was the obvious mnemonic
      // but it collides with 1Password's "show app" hotkey on macOS, which
      // ate the keystroke before we ever saw it. The call 400s for non-
      // impersonating sessions — only redirect on success, otherwise a
      // misfired shortcut would yank a regular user back to the dashboard.
      if (mod && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        void authClient.admin.stopImpersonating().then((result) => {
          if (!result?.error) window.location.assign("/");
        });
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enabled]);
}

function ImpersonationBar({ email }: { email: string }) {
  return (
    <div className="flex h-7 w-full items-center justify-center gap-3 bg-amber-500 px-3 font-mono text-[11px] text-black">
      <span className="uppercase tracking-[0.2em]">impersonating</span>
      <span className="font-medium">{email}</span>
      <span className="opacity-70">·</span>
      <button
        type="button"
        onClick={() => {
          void authClient.admin.stopImpersonating().finally(() => {
            window.location.assign("/");
          });
        }}
        className="underline underline-offset-2 hover:opacity-80"
      >
        stop (⌘⇧P)
      </button>
    </div>
  );
}

function BillingLimitBar() {
  return (
    <div className="flex h-7 w-full items-center justify-center gap-2 bg-danger px-3 text-[11px] text-white">
      <span className="font-semibold">Ingest paused</span>
      <span className="opacity-90">You’ve hit your Free plan limits.</span>
      <Link
        to="/settings?scope=org&section=billing"
        className="font-medium underline underline-offset-2 hover:opacity-80"
      >
        Add a card to switch to pay-as-you-go →
      </Link>
    </div>
  );
}

function RouteContainer({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const incidentDetail = /^\/incidents\/[^/]+/.test(pathname);
  const wide = pathname.startsWith("/dashboards/");
  if (incidentDetail) {
    return <div className="flex min-h-0 flex-1 flex-col">{children}</div>;
  }
  return (
    <div className={`mx-auto w-full px-6 pb-24 pt-6 ${wide ? "max-w-[2400px]" : "max-w-6xl"}`}>
      {children}
    </div>
  );
}

function TopNav() {
  const { pathname } = useLocation();
  const navLink = (href: string, label: string, extraPrefixes: string[] = []) => {
    const active =
      href === "/"
        ? pathname === "/" || pathname === ""
        : pathname.startsWith(href) || extraPrefixes.some((p) => pathname.startsWith(p));
    return (
      <Link
        key={href}
        to={href}
        className={
          active
            ? "text-[13px] font-medium text-fg underline underline-offset-[6px] decoration-1"
            : "text-[13px] font-medium text-muted transition-opacity hover:text-fg"
        }
      >
        {label}
      </Link>
    );
  };

  return (
    <nav className="flex items-center justify-between py-5">
      <div className="flex items-center gap-8">
        <Wordmark />
        <div className="hidden items-center gap-6 md:flex">
          {navLink("/", "Overview")}
          {navLink("/incidents", "Issues", ["/issues"])}
          {navLink("/alerts", "Alerts")}
          {navLink("/explore", "Explore")}
          {navLink("/dashboards", "Dashboards")}
          {navLink("/settings", "Settings")}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <ThemeToggle />
        <OrgProjectSwitcher />
        <UserMenu />
      </div>
    </nav>
  );
}

function UserMenu() {
  const { data } = useSession();
  const [open, setOpen] = useState(false);
  if (!data?.user) return null;
  const email = data.user.email;
  const initial = (data.user.name?.[0] ?? email[0] ?? "?").toUpperCase();

  async function handleSignOut() {
    setOpen(false);
    await authClient.signOut();
    window.location.href = "/";
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-7 w-7 items-center justify-center rounded-full bg-fg text-xs font-medium text-bg"
        aria-label={`Account menu for ${email}`}
      >
        {initial}
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-56 rounded-md border border-border bg-surface p-2 shadow-md">
          <div className="border-b border-border px-2 py-1.5 text-xs text-muted">{email}</div>
          <button
            type="button"
            onClick={handleSignOut}
            className="mt-1 w-full rounded px-2 py-1.5 text-left text-sm hover:bg-bg"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
