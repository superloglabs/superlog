import { timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  type ProjectMcpServerRepository,
  createDrizzleProjectMcpServerRepository,
} from "@superlog/db";
import type { Env, Hono } from "hono";

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
  fetch: (request: Request) => Promise<Response>;
  assertSafeUrl: (url: URL) => Promise<void>;
};

export function mountProjectMcpRelayPublic<E extends Env>(
  app: Hono<E>,
  overrides: Partial<RelayDependencies> = {},
): void {
  const deps: RelayDependencies = {
    repository: createDrizzleProjectMcpServerRepository(),
    fetch: (request) => fetch(request, { redirect: "manual" }),
    assertSafeUrl: assertPublicHttpsUrl,
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
    await deps.assertSafeUrl(upstreamUrl);
    const headers = new Headers();
    for (const name of REQUEST_HEADERS) {
      const value = c.req.header(name);
      if (value) headers.set(name, value);
    }
    headers.set(server.auth.headerName, server.auth.key);
    const body = c.req.method === "GET" ? undefined : await c.req.arrayBuffer();
    const upstream = await deps.fetch(
      new Request(upstreamUrl, {
        method: c.req.method,
        headers,
        body,
        redirect: "manual",
      }),
    );
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

export async function assertPublicHttpsUrl(url: URL): Promise<void> {
  if (url.protocol !== "https:") throw new Error("MCP relay upstream must use HTTPS");
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("MCP relay cannot access localhost");
  }
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("MCP relay cannot access private network addresses");
  }
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized === "::" || normalized.startsWith("fe80:")) return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (normalized.startsWith("2001:db8:")) return true;
  if (normalized.startsWith("::ffff:")) {
    return isPrivateAddress(normalized.slice("::ffff:".length));
  }
  const parts = normalized.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b !== undefined && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b !== undefined && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 2 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0) ||
    a === 224 ||
    a === 255
  );
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
