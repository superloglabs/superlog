import type { MiddlewareHandler } from "hono";

// An edge rule (load balancer or firewall) matches the path as the client sent
// it, while URL parsing here resolves "%2e%2e" and ".." before routing. A path
// such as /api/x/%2e%2e/auth/sign-up/email therefore skips a rule written for
// /api/auth/sign-up/email and still reaches that handler. Refuse any request
// whose raw path contains a dot segment, an encoded slash or backslash, a
// backslash, or an empty segment; no client of this API sends one.
export function hasAmbiguousPathSegment(rawPathAndQuery: string): boolean {
  const queryAt = rawPathAndQuery.indexOf("?");
  const path = queryAt === -1 ? rawPathAndQuery : rawPathAndQuery.slice(0, queryAt);
  if (/%2f|%5c|\\/i.test(path)) return true;
  if (path.includes("//")) return true;
  return path.split("/").some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment));
}

type NodeEnv = { incoming?: { url?: string } };

export function rawPathGuard(): MiddlewareHandler {
  return async (c, next) => {
    // @hono/node-server passes the Node request as env.incoming; its url is the
    // request target before WHATWG URL normalization.
    const raw = (c.env as NodeEnv | undefined)?.incoming?.url;
    if (raw !== undefined && hasAmbiguousPathSegment(raw)) {
      return c.json({ error: "invalid path" }, 400);
    }
    return next();
  };
}
