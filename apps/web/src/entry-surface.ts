export type EntrySurface = "marketing" | "product";

const PRODUCT_ROUTE_ROOTS = [
  "/app",
  "/org",
  "/activate",
  "/accept-invitation",
  "/oauth/consent",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/settings",
  "/explore",
  "/incidents",
  "/issues",
  "/alerts",
  "/dashboards",
  "/anomaly-scanner",
  "/connect",
  "/feedback/pr",
  "/design",
  "/explore",
  "/incidents",
  "/issues",
  "/alerts",
  "/dashboards",
  "/anomaly-scanner",
];

export function surfaceForPath(pathname: string, search = ""): EntrySurface {
  if (pathname === "/") {
    const params = new URLSearchParams(search);
    if (params.has("installation_id") && params.has("state")) return "product";
    if (params.has("gh") || params.has("slack") || params.has("sentry")) return "product";
  }
  return PRODUCT_ROUTE_ROOTS.some((root) => pathname === root || pathname.startsWith(`${root}/`))
    ? "product"
    : "marketing";
}
