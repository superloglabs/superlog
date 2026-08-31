type WebOriginEnv = {
  WEB_ORIGIN?: string;
  WEB_ORIGIN_ALIASES?: string;
};

function validOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" &&
      url.hostname !== "localhost" &&
      !url.hostname.endsWith(".localhost")
    ) {
      return null;
    }
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function configuredWebOrigins(env: WebOriginEnv = process.env): string[] {
  const canonical =
    validOrigin(env.WEB_ORIGIN ?? "http://localhost:5173") ?? "http://localhost:5173";
  const aliases = (env.WEB_ORIGIN_ALIASES ?? "")
    .split(",")
    .map((value) => validOrigin(value.trim()))
    .filter((value): value is string => value !== null);
  return Array.from(
    new Set([canonical, ...aliases, "http://localhost:5173", "http://127.0.0.1:5173"]),
  );
}
