import type { MiddlewareHandler } from "hono";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

type RequestHeaders = {
  method: string;
  header(name: string): string | undefined;
};

// The session cookie is scoped to the parent domain the web and API share, so
// a browser attaches it to requests that any sibling host starts, and
// SameSite=Lax does not separate subdomains of one site. Handlers also parse
// JSON from any content type, so a preflight-free text/plain POST reaches
// them. Refuse every state-changing, cookie-bearing request whose Origin (or,
// when a browser omits Origin, Sec-Fetch-Site) shows it came from a page
// outside the trusted web origins. Requests without cookies (bearer tokens,
// ingest keys, signed webhooks) are not ambient-credential requests and pass.
export function isForbiddenCrossOriginRequest(
  request: RequestHeaders,
  allowedOrigins: readonly string[],
): boolean {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return false;
  if (!request.header("cookie")) return false;
  const origin = request.header("origin");
  if (origin !== undefined) return !allowedOrigins.includes(origin);
  const fetchSite = request.header("sec-fetch-site");
  return fetchSite === "cross-site" || fetchSite === "same-site";
}

export function crossOriginGuard(allowedOrigins: readonly string[]): MiddlewareHandler {
  return async (c, next) => {
    if (isForbiddenCrossOriginRequest(c.req, allowedOrigins)) {
      return c.json({ error: "cross-origin request refused" }, 403);
    }
    return next();
  };
}
