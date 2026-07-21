import { useQueryClient } from "@tanstack/react-query";
import { useCustomer } from "autumn-js/react";
import { usePostHog } from "posthog-js/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, Navigate, Route, Routes, matchPath, useLocation } from "react-router-dom";
import { AcceptInvitation } from "./AcceptInvitation.tsx";
import { Activate } from "./Activate.tsx";
import { CommandPalette } from "./CommandPalette.tsx";
import { Explore } from "./Explore.tsx";
import { ForgotPassword } from "./ForgotPassword.tsx";
import { GcpCallback } from "./GcpCallback.tsx";
import { Issues } from "./Issues.tsx";
import { Landing } from "./Landing.tsx";
import { OauthConsent } from "./OauthConsent.tsx";
import { OrgProjectSwitcher } from "./OrgProjectSwitcher.tsx";
import { Overview } from "./Overview.tsx";
import { PrFeedback } from "./PrFeedback.tsx";
import { ProjectRouteBoundary } from "./ProjectRouteBoundary.tsx";
import { ProjectRouteProvider, useProjectPath } from "./ProjectRouteContext.tsx";
import { RailwayCallback } from "./RailwayCallback.tsx";
import { ResetPassword } from "./ResetPassword.tsx";
import { Settings } from "./Settings.tsx";
import { SignupSourceCapture } from "./SignupSourceCapture.tsx";
import { VercelCallback } from "./VercelCallback.tsx";
import { AlertEdit } from "./alerts/AlertEdit.tsx";
import { AlertsList } from "./alerts/AlertsList.tsx";
import { AnomalyScanDetail } from "./anomaly-scanner/AnomalyScanDetail.tsx";
import { AnomalyScanner } from "./anomaly-scanner/AnomalyScanner.tsx";
import { useMe } from "./api.ts";
import { authClient, useSession } from "./auth-client.ts";
import { signalAtHardCap } from "./billing.ts";
import { DashboardView } from "./dashboards/DashboardView.tsx";
import { DashboardsList } from "./dashboards/DashboardsList.tsx";
import { ProductShell } from "./design/ProductShell.tsx";
import { ThemeToggle } from "./design/ui.tsx";
import { McpInstallPill } from "./onboarding/McpInstallPill.tsx";
import { OnboardingGate } from "./onboarding/OnboardingGate.tsx";
import { useDemoExploration } from "./onboarding/demoExploration.tsx";
import {
  appLocationFromProjectRoute,
  appPathFromProjectRoute,
  buildProjectPath,
  canonicalProjectLocation,
  legacyProductLocation,
} from "./project-route.ts";
import {
  APP_FRAME_CLASS,
  PAGE_SCROLL_CONTAINER_CLASS,
  isDetailWorkspacePath,
} from "./route-layout.ts";
import { buildSignupEventProperties, readFirstTouchAttribution } from "./signupAttribution.ts";
import { startSkillOnboarding } from "./skillOnboarding.ts";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4100";

function GithubInstallCallbackForwarder() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (!params.has("installation_id") || !params.has("state")) return;
    window.location.replace(`${API_URL}/github/install/callback${window.location.search}`);
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
      // First-touch attribution (source + UTM + referrer) was stashed at landing
      // in localStorage. The signup event itself is now emitted server-side and
      // can't carry it, so attach it to the person via $set_once (write-once, so
      // a later touch never clobbers the original) — person-on-events then makes
      // it queryable on the server-side user_signed_up / organization_created
      // events too.
      const attr =
        typeof window === "undefined" ? {} : (readFirstTouchAttribution(window.localStorage) ?? {});
      const authMethod =
        typeof window === "undefined"
          ? undefined
          : window.localStorage.getItem("superlog.auth.last_provider")?.trim() || undefined;
      const attribution = buildSignupEventProperties(attr, { authMethod });
      posthog.identify(
        data.user.id,
        { email: data.user.email, name: data.user.name },
        Object.keys(attribution).length > 0 ? attribution : undefined,
      );
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
      <PostHogUserSync />
      <ActiveOrgSync />
      <Routes>
        <Route path="/activate" element={<Activate />} />
        <Route path="/accept-invitation" element={<AcceptInvitation />} />
        <Route path="/oauth/consent" element={<OauthConsent />} />
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
        <Route path="/connect/gcp" element={<GcpCallback />} />
        <Route path="/app/*" element={<AuthenticatedApp />} />
        <Route path="/org/*" element={<LegacyProductRouteRedirect />} />
        <Route path="*" element={<LegacyProductRouteRedirect />} />
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
  if (data) return <Navigate to="/app" replace />;
  return <Landing initialAuthMode="sign-up" />;
}

function AuthenticatedApp() {
  const { data, isPending } = useSession();
  const me = useMe();
  const location = useLocation();
  const { pathname } = location;
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
  const scopedRoute = matchPath("/app/org/:orgSlug/project/:projectSlug/*", pathname);
  const orgSlug = scopedRoute?.params.orgSlug;
  const projectSlug = scopedRoute?.params.projectSlug;
  if (!orgSlug && me.data?.org && me.data.project) {
    return (
      <Navigate
        replace
        to={canonicalProjectLocation(
          { orgSlug: me.data.org.slug, projectSlug: me.data.project.slug },
          { pathname, search: location.search, hash: location.hash },
        )}
      />
    );
  }
  const appLocation = appLocationFromProjectRoute({
    pathname,
    search: location.search,
    hash: location.hash,
  });
  const projectRoot =
    orgSlug && projectSlug ? buildProjectPath({ orgSlug, projectSlug }, "/") : "/app";
  const app = (
    <OnboardingGate>
      <div className={APP_FRAME_CLASS}>
        <TopRibbon
          impersonating={impersonating}
          email={data.user.email}
          billingPaused={billingPaused}
        />
        <ProductShell
          toolbar={<ProductToolbar />}
          anomalyScannerEnabled={me.data?.features?.anomalyScanner === true}
        >
          <RouteContainer>
            <Routes location={appLocation}>
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
              <Route
                path="/anomaly-scanner"
                element={
                  me.data?.features?.anomalyScanner === true ? (
                    <AnomalyScanner />
                  ) : (
                    <Navigate to={projectRoot} replace />
                  )
                }
              />
              <Route
                path="/anomaly-scanner/scans/:scanId"
                element={
                  me.data?.features?.anomalyScanner === true ? (
                    <AnomalyScanDetail />
                  ) : (
                    <Navigate to={projectRoot} replace />
                  )
                }
              />
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<Overview />} />
            </Routes>
          </RouteContainer>
        </ProductShell>
      </div>
      <CommandPalette />
      <McpInstallPill />
    </OnboardingGate>
  );
  const projectApp =
    orgSlug && projectSlug ? (
      <ProjectRouteProvider slugs={{ orgSlug, projectSlug }}>{app}</ProjectRouteProvider>
    ) : (
      app
    );
  if (!orgSlug || !projectSlug) return projectApp;
  return (
    <ProjectRouteBoundary me={me.data} slugs={{ orgSlug, projectSlug }}>
      {projectApp}
    </ProjectRouteBoundary>
  );
}

function LegacyProductRouteRedirect() {
  const location = useLocation();
  return <Navigate replace to={legacyProductLocation(location)} />;
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
          if (!result?.error) window.location.assign("/app");
        });
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enabled]);
}

// Single app-wide status ribbon slot. Only one bar shows at a time, in priority
// order: impersonation (staff) > demo mode > billing paused. Demo mode reads the
// exploration context so the bar tracks the same opt-in that gates the demo app.
function TopRibbon({
  impersonating,
  email,
  billingPaused,
}: {
  impersonating: boolean;
  email: string;
  billingPaused: boolean;
}) {
  const { exploring } = useDemoExploration();
  if (impersonating) return <ImpersonationBar email={email} />;
  if (exploring) return <DemoModeBar />;
  if (billingPaused) return <BillingLimitBar />;
  return null;
}

function DemoModeBar() {
  const { stopExploring } = useDemoExploration();
  return (
    <div className="flex h-7 w-full items-center justify-center gap-2 bg-[#8C98F0] px-3 text-[11px] text-black">
      <span className="font-semibold">Demo mode</span>
      <span className="opacity-80">You’re viewing sample data.</span>
      <button
        type="button"
        onClick={stopExploring}
        className="font-medium underline underline-offset-2 hover:opacity-80"
      >
        Connect your app →
      </button>
    </div>
  );
}

function ImpersonationBar({ email }: { email: string }) {
  return (
    <div className="flex h-7 w-full items-center justify-center gap-3 bg-amber-500 px-3 text-[11px] text-black">
      <span className="uppercase tracking-[0.2em]">impersonating</span>
      <span className="font-medium">{email}</span>
      <span className="opacity-70">·</span>
      <button
        type="button"
        onClick={() => {
          void authClient.admin.stopImpersonating().finally(() => {
            window.location.assign("/app");
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
  const projectPath = useProjectPath();
  return (
    <div className="flex h-7 w-full items-center justify-center gap-2 bg-danger px-3 text-[11px] text-white">
      <span className="font-semibold">Ingest paused</span>
      <span className="opacity-90">You’ve hit your Free plan limits.</span>
      <Link
        to={projectPath("/settings?scope=org&section=billing")}
        className="font-medium underline underline-offset-2 hover:opacity-80"
      >
        Add a card to switch to pay-as-you-go →
      </Link>
    </div>
  );
}

function RouteContainer({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const appPath = appPathFromProjectRoute(pathname);
  const detailWorkspace = isDetailWorkspacePath(appPath);
  const wide = appPath.startsWith("/dashboards/");
  if (detailWorkspace) {
    return <div className="flex min-h-0 flex-1 flex-col">{children}</div>;
  }
  return (
    <div className={PAGE_SCROLL_CONTAINER_CLASS}>
      <div
        className={`mx-auto w-full px-5 pb-24 pt-8 sm:px-6 lg:px-8 ${wide ? "max-w-[2400px]" : "max-w-[1180px]"}`}
      >
        {children}
      </div>
    </div>
  );
}

function ProductToolbar() {
  return (
    <>
      <ThemeToggle />
      <OrgProjectSwitcher />
      <UserMenu />
    </>
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
