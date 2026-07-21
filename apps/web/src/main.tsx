import "./instrumentation";
import "@fontsource/geist-pixel/latin.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AutumnProvider } from "autumn-js/react";
import { PostHogProvider } from "posthog-js/react";
import React, { type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.tsx";
import { DesignLanguage } from "./design/DesignLanguage.tsx";
import { HomeDashboardMockups } from "./design/HomeDashboardMockups.tsx";
import { tracer } from "./instrumentation";
import "./index.css";
import "react-grid-layout/css/styles.css";
import "./dashboards/grid.css";

const bootSpan = tracer.startSpan("app.bootstrap", {
  attributes: { "app.path": window.location.pathname },
});

// Wrap the app in PostHog only when a project token is configured. Local dev
// and worktrees don't set VITE_PUBLIC_POSTHOG_PROJECT_TOKEN, so analytics stays
// off there instead of initializing against an empty key.
const posthogToken = import.meta.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN;
function Analytics({ children }: { children: ReactNode }) {
  if (!posthogToken) return <>{children}</>;
  return (
    <PostHogProvider
      apiKey={posthogToken}
      options={{
        api_host: import.meta.env.VITE_PUBLIC_POSTHOG_HOST || "https://eu.i.posthog.com",
        ui_host: import.meta.env.VITE_PUBLIC_POSTHOG_UI_HOST || "https://eu.posthog.com",
        defaults: "2026-01-30",
        capture_exceptions: true,
        debug: import.meta.env.DEV,
      }}
    >
      {children}
    </PostHogProvider>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

if (window.location.pathname.startsWith("/design")) {
  // The storybook composes real app components (e.g. IncidentRow), some of which
  // call react-query hooks. useQuery calls useQueryClient() unconditionally —
  // even when `enabled: false` — so a provider must wrap the storybook too, or
  // any such page throws "No QueryClient set". Queries that do fire just fail
  // gracefully against the unauthenticated /design origin.
  const designQueryClient = new QueryClient({
    defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
  });
  root.render(
    <React.StrictMode>
      <BrowserRouter>
        <QueryClientProvider client={designQueryClient}>
          {window.location.pathname === "/design/home-dashboard-mockups" ? (
            <HomeDashboardMockups />
          ) : (
            <DesignLanguage />
          )}
        </QueryClientProvider>
      </BrowserRouter>
    </React.StrictMode>,
  );
  bootSpan.setAttribute("app.mode", "design");
  bootSpan.end();
} else {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
  });

  root.render(
    <React.StrictMode>
      <Analytics>
        <BrowserRouter>
          <QueryClientProvider client={queryClient}>
            {/* Billing context. Web and API are separate origins, so point
                Autumn at the API; useBetterAuth routes through /api/auth/autumn
                with the session cookie. Harmless when billing is unconfigured. */}
            <AutumnProvider
              backendUrl={import.meta.env.VITE_API_URL ?? "http://localhost:4100"}
              useBetterAuth
            >
              <App />
            </AutumnProvider>
          </QueryClientProvider>
        </BrowserRouter>
      </Analytics>
    </React.StrictMode>,
  );
  bootSpan.setAttribute("app.mode", "main");
  bootSpan.end();
}
