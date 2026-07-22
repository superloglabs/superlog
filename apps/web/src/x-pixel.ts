// X (Twitter) website tag loader.
//
// Injected only when `VITE_X_PIXEL_ID` is set, mirroring the GTM/PostHog gating
// in `main.tsx`: local dev, worktrees, and self-hosted builds leave the var
// unset, so no ad tag loads there. The pixel id is supplied at build time by
// the deployment, never hardcoded here.
//
// This installs the base tag (page views + retargeting / "site visits"). Server
// conversions (signup, first telemetry) are reported separately server-side.

const X_PIXEL_SCRIPT_ID = "x-pixel-loader";
const X_PIXEL_SRC = "https://static.ads-twitter.com/uwt.js";

type Twq = ((...args: unknown[]) => void) & {
  version?: string;
  queue?: unknown[];
  exe?: unknown;
};

interface InitXPixelOptions {
  doc?: Document;
  win?: Window & { twq?: Twq };
}

/**
 * Initialize the X pixel against `pixelId`: install the `twq` command queue,
 * inject the async `uwt.js` loader, and configure the pixel (which sends the
 * initial page view).
 *
 * No-ops (returns false) when the id is blank or the loader is already present,
 * so it's safe to call on every boot and under HMR. Returns true when it
 * injected the loader.
 */
export function initXPixel(
  pixelId: string | undefined,
  options: InitXPixelOptions = {},
): boolean {
  if (!pixelId) return false;

  const doc = options.doc ?? (typeof document !== "undefined" ? document : undefined);
  if (!doc) return false;
  const win =
    options.win ??
    (doc.defaultView as (Window & { twq?: Twq }) | null) ??
    (typeof window !== "undefined" ? (window as Window & { twq?: Twq }) : undefined);
  if (!win) return false;
  if (doc.getElementById(X_PIXEL_SCRIPT_ID)) return false;

  // The standard uwt.js command-queue shim: calls before the script loads are
  // queued and replayed once it's ready.
  if (!win.twq) {
    const twq: Twq = (...args: unknown[]) => {
      if (twq.exe) (twq.exe as (...a: unknown[]) => void).apply(twq, args);
      else twq.queue?.push(args);
    };
    twq.version = "1.1";
    twq.queue = [];
    win.twq = twq;
  }

  const script = doc.createElement("script");
  script.id = X_PIXEL_SCRIPT_ID;
  script.async = true;
  script.src = X_PIXEL_SRC;
  const first = doc.getElementsByTagName("script")[0];
  if (first?.parentNode) first.parentNode.insertBefore(script, first);
  else (doc.head ?? doc.getElementsByTagName("head")[0]).appendChild(script);

  win.twq("config", pixelId);
  return true;
}
