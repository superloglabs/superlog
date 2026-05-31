import type { ClickHouseClient } from "@clickhouse/client";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { db, hashToken, schema } from "@superlog/db";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { logger } from "../logger.js";
import { loadMcpConfig, type McpConfig } from "./config.js";
import { mountOauthDecision, mountOauthEndpoints, mountOauthMetadata } from "./oauth.js";
import { createMcpServerForSession } from "./server.js";

const log = logger.child({ scope: "mcp-bearer" });

type TokenContext = {
  tokenId: string;
  projectId: string;
  userId: string;
  clientId: string;
  scope: string | null;
  resource: string;
  allowedOrgId?: string;
  telemetryOnly?: boolean;
};

export function mountMcpPublic<T extends Hono<any, any, any>>(app: T, ch: ClickHouseClient): void {
  const cfg = loadMcpConfig();

  mountOauthMetadata(app, cfg);
  mountOauthEndpoints(app, cfg);

  app.all("/mcp", async (c) => {
    const header = c.req.header("authorization");
    if (!header?.toLowerCase().startsWith("bearer ")) {
      return unauthorized(cfg, "no bearer token", { method: c.req.method });
    }
    const token = header.slice(7).trim();
    const resolved = await resolveToken(token, cfg);
    if ("reason" in resolved) {
      return unauthorized(cfg, resolved.reason, {
        method: c.req.method,
        tokenPrefix: token.slice(0, 20),
      });
    }
    const tokenCtx = resolved;

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    const server = createMcpServerForSession({
      ch,
      userId: tokenCtx.userId,
      tokenId: tokenCtx.tokenId,
      activeProjectId: tokenCtx.projectId,
      allowedOrgId: tokenCtx.allowedOrgId,
      telemetryOnly: tokenCtx.telemetryOnly,
    });
    // handleRequest returns immediately with a Response wrapping a ReadableStream
    // (Content-Type: text/event-stream). The server writes JSON-RPC responses
    // into that stream asynchronously, so we cannot close the server here —
    // doing so would tear down the stream before the client reads it. Tie the
    // server lifetime to the transport instead.
    transport.onclose = () => {
      void server.close().catch(() => {});
    };
    await server.connect(transport);
    return await transport.handleRequest(c.req.raw, {
      authInfo: {
        token,
        clientId: tokenCtx.clientId,
        scopes: tokenCtx.scope ? tokenCtx.scope.split(" ") : [],
        resource: new URL(tokenCtx.resource),
      },
    });
  });
}

export function mountMcpAuthed(
  app: Hono<{ Variables: { userId: string; orgId: string | null } }>,
): void {
  const cfg = loadMcpConfig();
  mountOauthDecision(app, cfg);
}

async function resolveToken(
  token: string,
  cfg: McpConfig,
): Promise<TokenContext | { reason: string }> {
  const row = await db.query.mcpOauthTokens.findFirst({
    where: eq(schema.mcpOauthTokens.accessHash, hashToken(token)),
  });
  if (!row) return { reason: "token not found" };
  if (row.revokedAt) return { reason: "token revoked" };
  if (row.accessExpiresAt.getTime() < Date.now()) return { reason: "token expired" };
  // Compare the stored resource leniently: normalize trailing slashes and
  // accept the API origin as an alias for the MCP endpoint. Older tokens
  // issued before canonicalization might have non-canonical values stored.
  const stored = row.resource.replace(/\/+$/, "");
  if (stored !== cfg.resource && stored !== cfg.apiBaseUrl) {
    return { reason: `resource mismatch (stored=${row.resource})` };
  }
  return {
    tokenId: row.id,
    projectId: row.projectId,
    userId: row.userId,
    clientId: row.clientId,
    scope: row.scope,
    resource: row.resource,
    allowedOrgId: parseOrgScope(row.scope),
    telemetryOnly: hasScopePart(row.scope, "superlog:telemetry"),
  };
}

function parseOrgScope(scope: string | null): string | undefined {
  const prefix = "superlog:org:";
  return scope
    ?.split(/\s+/)
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length);
}

function hasScopePart(scope: string | null, expected: string): boolean {
  return scope?.split(/\s+/).includes(expected) ?? false;
}

function unauthorized(
  cfg: McpConfig,
  description: string,
  extras: Record<string, unknown> = {},
): Response {
  log.warn({ ...extras, description }, "mcp 401");
  const wwwAuth = [
    `Bearer realm="mcp"`,
    `resource_metadata="${cfg.apiBaseUrl}/.well-known/oauth-protected-resource"`,
    `error="invalid_token"`,
    `error_description="${description.replace(/"/g, "'")}"`,
  ].join(", ");
  return new Response(JSON.stringify({ error: "invalid_token", error_description: description }), {
    status: 401,
    headers: { "content-type": "application/json", "www-authenticate": wwwAuth },
  });
}
