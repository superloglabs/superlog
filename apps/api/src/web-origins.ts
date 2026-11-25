type WebOriginEnv = {
  WEB_ORIGIN?: string;
  WEB_ORIGIN_ALIASES?: string;
  SUPERLOG_ENV?: string;
  NODE_ENV?: string;
};

const LOCAL_DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];

function isProduction(env: WebOriginEnv): boolean {
  const deployment = env.SUPERLOG_ENV?.trim() || env.NODE_ENV?.trim() || "development";
  return deployment.toLowerCase() === "production";
}

function validOrigin(value: string, production: boolean): string | null {
  try {
    const url = new URL(value);
    const local = url.hostname === "localhost" || url.hostname.endsWith(".localhost");
    // Production trusts HTTPS origins only; local origins are dev conveniences
    // that any page served on a victim's own machine could otherwise use.
    if (production ? url.protocol !== "https:" || local : url.protocol !== "https:" && !local) {
      return null;
    }
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function configuredWebOrigins(env: WebOriginEnv = process.env): string[] {
  const production = isProduction(env);
  const canonical =
    validOrigin(env.WEB_ORIGIN ?? "http://localhost:5173", production) ??
    (production ? null : "http://localhost:5173");
  const aliases = (env.WEB_ORIGIN_ALIASES ?? "")
    .split(",")
    .map((value) => validOrigin(value.trim(), production))
    .filter((value): value is string => value !== null);
  return Array.from(
    new Set(
      [canonical, ...aliases, ...(production ? [] : LOCAL_DEV_ORIGINS)].filter(
        (value): value is string => value !== null,
      ),
    ),
  );
}
