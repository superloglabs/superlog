import "./instrumentation";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AutumnProvider } from "autumn-js/react";
import { PostHogProvider } from "posthog-js/react";
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.tsx";
import { DesignLanguage } from "./design/DesignLanguage.tsx";
import { tracer } from "./instrumentation";
import "./index.css";
import "react-grid-layout/css/styles.css";
import "./dashboards/grid.css";

const bootSpan = tracer.startSpan("app.bootstrap", {
  attributes: { "app.path": window.location.pathname },
});

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

if (window.location.pathname.startsWith("/design")) {
  root.render(
    <React.StrictMode>
      <BrowserRouter>
        <DesignLanguage />
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
      <PostHogProvider
        apiKey={import.meta.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN!}
        options={{
          api_host: import.meta.env.VITE_PUBLIC_POSTHOG_HOST || "https://eu.i.posthog.com",
          ui_host: "https://eu.posthog.com",
          defaults: "2026-01-30",
          capture_exceptions: true,
          debug: import.meta.env.DEV,
        }}
      >
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
      </PostHogProvider>
    </React.StrictMode>,
  );
  bootSpan.setAttribute("app.mode", "main");
  bootSpan.end();
}
