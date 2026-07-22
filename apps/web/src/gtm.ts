// Google Tag Manager loader.
//
// Injected only when `VITE_GTM_CONTAINER_ID` is set, mirroring the PostHog
// gating in `main.tsx`: local dev, worktrees, and self-hosted builds leave the
// var unset, so no tag manager loads there. The container id is supplied at
// build time by the deployment, never hardcoded here.

const GTM_SCRIPT_ID = "gtm-loader";

/** Build the gtm.js async-loader URL for a container id. */
export function gtmLoaderSrc(containerId: string): string {
  return `https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(containerId)}`;
}

interface InitGtmOptions {
  doc?: Document;
  dataLayer?: unknown[];
  now?: number;
}

/**
 * Initialize GTM against `containerId`: push the `gtm.js` start event onto the
 * data layer and inject the async loader as high in `<head>` as possible.
 *
 * No-ops (returns false) when the id is blank or the loader is already present,
 * so it's safe to call on every boot and under HMR. Returns true when it
 * injected the loader.
 */
export function initGtm(
  containerId: string | undefined,
  options: InitGtmOptions = {},
): boolean {
  if (!containerId) return false;

  const doc = options.doc ?? (typeof document !== "undefined" ? document : undefined);
  if (!doc) return false;
  if (doc.getElementById(GTM_SCRIPT_ID)) return false;

  const w = doc.defaultView as (Window & { dataLayer?: unknown[] }) | null;
  const dataLayer =
    options.dataLayer ?? ((w ?? (globalThis as { dataLayer?: unknown[] })).dataLayer ??= []);
  const now = options.now ?? Date.now();
  dataLayer.push({ "gtm.start": now, event: "gtm.js" });

  const script = doc.createElement("script");
  script.id = GTM_SCRIPT_ID;
  script.async = true;
  script.src = gtmLoaderSrc(containerId);
  const head = doc.head ?? doc.getElementsByTagName("head")[0];
  head.insertBefore(script, head.firstChild);
  return true;
}
