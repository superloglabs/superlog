import { timingSafeEqual } from "node:crypto";
import {
  type ProjectMcpServerRepository,
  createDrizzleProjectMcpServerRepository,
} from "@superlog/db";
import type { Env, Hono } from "hono";
import { strictProjectMcpFetch } from "./project-mcp-http.js";

const REQUEST_HEADERS = [
  "accept",
  "content-type",
  "last-event-id",
  "mcp-protocol-version",
  "mcp-session-id",
];
const RESPONSE_HEADERS = ["cache-control", "content-type", "mcp-session-id", "retry-after"];

type RelayDependencies = {
  repository: Pick<ProjectMcpServerRepository, "get">;
  fetch: typeof fetch;
};

export function mountProjectMcpRelayPublic<E extends Env>(
  app: Hono<E>,
  overrides: Partial<RelayDependencies> = {},
): void {
  const deps: RelayDependencies = {
    repository: createDrizzleProjectMcpServerRepository(),
    fetch: strictProjectMcpFetch,
    ...overrides,
  };

  app.on(["POST", "GET", "DELETE"], "/api/agent-mcp-relay/:projectId/:serverId", async (c) => {
    const server = await deps.repository.get(c.req.param("projectId"), c.req.param("serverId"));
    if (!server || server.auth.type !== "api_key") {
      return c.json({ error: "relay target not found" }, 404);
    }
    const authorization = c.req.header("authorization") ?? "";
    const token = authorization.toLowerCase().startsWith("bearer ")
      ? authorization.slice(7).trim()
      : "";
    if (!safeEqual(token, server.auth.relayToken)) {
      return c.json({ error: "invalid relay credential" }, 401);
    }
    const upstreamUrl = new URL(server.url);
    const headers = new Headers();
    for (const name of REQUEST_HEADERS) {
      const value = c.req.header(name);
      if (value) headers.set(name, value);
    }
    headers.set(server.auth.headerName, server.auth.key);
    const body = c.req.method === "GET" ? undefined : await c.req.arrayBuffer();
    const upstream = await deps.fetch(upstreamUrl, {
      method: c.req.method,
      headers,
      body,
      redirect: "manual",
    });
    const responseHeaders = new Headers();
    for (const name of RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  });
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
