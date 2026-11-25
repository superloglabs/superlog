import type { MiddlewareHandler } from "hono";

// A "." or ".." path segment, literal or percent-encoded, between forward
// slashes or backslashes.
const dotSegment = /(?:^|[/\\])(?:\.|%2e){1,2}(?:[/\\]|$)/iu;

// Node's HTTP adapter parses the request target as a WHATWG URL, which
// resolves dot segments (including percent-encoded ones) and treats a
// backslash as a slash. Path-based rules in front of the API see the target
// as sent, so a target with dot segments can be checked as one path and
// routed as another. Browsers and HTTP clients resolve dot segments before
// they send a request.
export function hasDotSegment(target: string): boolean {
  const path = target.split(/[?#]/u, 1)[0] ?? "";
  return dotSegment.test(path);
}

// The request target as received, when the Node adapter provides it.
function receivedTarget(env: unknown): string | undefined {
  const url = (env as { incoming?: { url?: unknown } } | undefined)?.incoming?.url;
  return typeof url === "string" ? url : undefined;
}

export const rejectDotSegments: MiddlewareHandler = async (c, next) => {
  const target = receivedTarget(c.env);
  if (target !== undefined && hasDotSegment(target)) {
    return c.json({ error: "invalid request path" }, 400);
  }
  await next();
};
