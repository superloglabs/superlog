import { db, schema } from "@superlog/db";
import { eq } from "drizzle-orm";
import { logger } from "../logger.js";
import { hasMcpWriteAccess } from "./scope-authorization.js";

// When a project's customer moves to a workspace of the Superlog application,
// their MCP clients keep this address and their tokens. Once the project is
// cut over, its requests go to the application's MCP endpoint for the
// workspace with the project's ID. The application trusts the request through
// a shared credential, LEGACY_MCP_FORWARD_TOKEN, and acts as the workspace
// member with the token owner's email. This is removed when this product
// shuts down.

const log = logger.child({ scope: "mcp-forwarding" });

export const MCP_FORWARD_HEADERS = {
  token: "x-legacy-mcp-forward-token",
  projectId: "x-legacy-mcp-project-id",
  email: "x-legacy-mcp-user-email",
  access: "x-legacy-mcp-access",
} as const;

export type McpForwardAccess = "read" | "read-write";

// A token without the full read/write grant, or limited to telemetry, may use
// only the application's read-only tools.
export function mcpForwardAccess(scope: string | null, telemetryOnly: boolean): McpForwardAccess {
  const scopes = scope?.split(/\s+/).filter(Boolean) ?? [];
  return hasMcpWriteAccess(scopes) && !telemetryOnly ? "read-write" : "read";
}

// The application's MCP endpoint at a workspace origin. Only HTTPS origins,
// or plain HTTP on localhost for local development, receive the credential.
export function workspaceMcpEndpoint(workspaceUrl: string): URL | null {
  let url: URL;
  try {
    url = new URL(workspaceUrl);
  } catch {
    return null;
  }
  const local =
    url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if ((url.protocol !== "https:" && !local) || url.username || url.password) return null;
  return new URL("/api/mcp", url.origin);
}

export type McpForward = {
  access: McpForwardAccess;
  credential: string;
  email: string;
  endpoint: URL;
  projectId: string;
};

const FORWARD_TIMEOUT_MS = 120_000;
// The client's Authorization header holds this product's token and stays here.
const FORWARDED_REQUEST_HEADERS = ["accept", "content-type", "mcp-protocol-version"];
const FORWARDED_RESPONSE_HEADERS = ["cache-control", "content-type"];

// Sends the client's JSON-RPC request on unchanged and streams the answer back.
export async function forwardMcpRequest(
  request: Request,
  forward: McpForward,
  send: typeof fetch = fetch,
): Promise<Response> {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set(MCP_FORWARD_HEADERS.token, forward.credential);
  headers.set(MCP_FORWARD_HEADERS.projectId, forward.projectId);
  headers.set(MCP_FORWARD_HEADERS.email, forward.email);
  headers.set(MCP_FORWARD_HEADERS.access, forward.access);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const upstream = await send(forward.endpoint, {
    body: hasBody ? await request.arrayBuffer() : undefined,
    headers,
    method: request.method,
    signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
  });
  const responseHeaders = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  return new Response(upstream.body, { headers: responseHeaders, status: upstream.status });
}

function forwardError(status: 502 | 503, message: string): Response {
  return new Response(JSON.stringify({ error: "forwarding_failed", error_description: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Forwards a request authenticated for a cut-over project. A missing
// credential or an invalid workspace address is a configuration error, so the
// request fails instead of being served here.
export async function forwardToWorkspace(
  request: Request,
  token: {
    projectId: string;
    scope: string | null;
    telemetryOnly?: boolean;
    tokenId: string;
    userId: string;
  },
  workspaceUrl: string,
  send: typeof fetch = fetch,
): Promise<Response> {
  const credential = process.env.LEGACY_MCP_FORWARD_TOKEN?.trim();
  const endpoint = workspaceMcpEndpoint(workspaceUrl);
  if (!credential || !endpoint) {
    log.error(
      { projectId: token.projectId, credential: Boolean(credential), endpoint: Boolean(endpoint) },
      "mcp forwarding is not configured",
    );
    return forwardError(503, "This project has moved, and forwarding is not configured.");
  }
  const user = await db.query.users.findFirst({
    columns: { email: true },
    where: eq(schema.users.id, token.userId),
  });
  if (!user) return forwardError(503, "The token's user was not found.");
  try {
    const response = await forwardMcpRequest(
      request,
      {
        access: mcpForwardAccess(token.scope, token.telemetryOnly ?? false),
        credential,
        email: user.email,
        endpoint,
        projectId: token.projectId,
      },
      send,
    );
    log.info(
      { projectId: token.projectId, tokenId: token.tokenId, status: response.status },
      "mcp forwarded",
    );
    return response;
  } catch (error) {
    log.error(
      { projectId: token.projectId, tokenId: token.tokenId, err: error },
      "mcp forwarding failed",
    );
    return forwardError(502, "The project's workspace is unavailable.");
  }
}
