export type WebView =
  | "chooser"
  | "aws"
  | "cloudflare"
  | "gcp"
  | "vercel"
  | "railway"
  | "render"
  | "code"
  | "deploy";

export function initialWebViewFromSearch(search: string): WebView {
  const params = new URLSearchParams(search);
  if (params.get("vercel") === "drains_unavailable") return "code";
  if (params.has("cloudflare")) return "cloudflare";
  if (params.has("vercel")) return "vercel";
  if (params.has("railway")) return "railway";
  return "chooser";
}

export function stripHandledOnboardingParams(search: string): string {
  const params = new URLSearchParams(search);
  if (params.get("vercel") !== "drains_unavailable") return search;
  params.delete("vercel");
  const next = params.toString();
  return next ? `?${next}` : "";
}
