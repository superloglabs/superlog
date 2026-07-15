import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";

export const DEFAULT_API_BODY_BYTES = 2 * 1024 * 1024;
export const MCP_RELAY_BODY_BYTES = 8 * 1024 * 1024;
export const SOURCE_MAP_UPLOAD_BODY_BYTES = 40 * 1024 * 1024;

export function requestBodyLimit(maxSize: number): MiddlewareHandler {
  return bodyLimit({
    maxSize,
    onError: (c) => c.json({ error: "payload too large" }, 413),
  });
}

const defaultApiBodyLimit = requestBodyLimit(DEFAULT_API_BODY_BYTES);
const mcpRelayBodyLimit = requestBodyLimit(MCP_RELAY_BODY_BYTES);
const sourceMapBodyLimit = requestBodyLimit(SOURCE_MAP_UPLOAD_BODY_BYTES);

export const apiRequestBodyLimit: MiddlewareHandler = (c, next) => {
  const path = c.req.path;
  if (/^\/api\/v1\/projects\/[^/]+\/sourcemaps$/.test(path)) {
    return sourceMapBodyLimit(c, next);
  }
  if (path.startsWith("/api/agent-mcp-relay/")) {
    return mcpRelayBodyLimit(c, next);
  }
  return defaultApiBodyLimit(c, next);
};
