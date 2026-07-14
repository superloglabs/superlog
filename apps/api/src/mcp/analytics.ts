// Product analytics for MCP tool usage.
//
// Every MCP tool invocation emits a server-side `mcp_tool_called` event so we
// can see who uses MCP and how (by user, org, tool, outcome). Delivery rides
// captureServerEvent, which is env-gated and best-effort — with no PostHog
// token configured this is a no-op, and a capture failure never affects the
// tool call it describes.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { captureServerEvent, db, schema } from "@superlog/db";
import { eq } from "drizzle-orm";
import { logger } from "../logger.js";
import type { McpSession } from "./server.js";

const log = logger.child({ scope: "mcp-analytics" });

const MAX_ERROR_LENGTH = 300;

type AnyToolHandler = (...args: unknown[]) => unknown;
type AnyRegisterTool = (
  name: string,
  config: Record<string, unknown>,
  handler: AnyToolHandler,
) => unknown;

/**
 * Patch `server.registerTool` so every tool registered afterwards — including
 * by the alert/dashboard/incident/agent-config modules — emits an analytics
 * event per invocation. Must run before any tools are registered.
 */
export function instrumentMcpToolAnalytics(server: McpServer, session: McpSession): void {
  const original = (server.registerTool as AnyRegisterTool).bind(server);
  (server as unknown as { registerTool: AnyRegisterTool }).registerTool = (
    name,
    config,
    handler,
  ) =>
    original(name, config, async (...args: unknown[]) => {
      // Resolve the target project before invoking: set_active_project mutates
      // the session default, and we want the project the call was aimed at.
      const projectId = effectiveProjectId(args[0], session);
      const startedAt = performance.now();
      try {
        const result = await handler(...args);
        const isError = (result as { isError?: unknown } | null | undefined)?.isError === true;
        emitToolCalled(session, {
          tool: name,
          projectId,
          success: !isError,
          durationMs: performance.now() - startedAt,
        });
        return result;
      } catch (err) {
        emitToolCalled(session, {
          tool: name,
          projectId,
          success: false,
          durationMs: performance.now() - startedAt,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    });
}

function effectiveProjectId(input: unknown, session: McpSession): string {
  const explicit = (input as { project_id?: unknown } | null | undefined)?.project_id;
  return typeof explicit === "string" ? explicit : session.activeProjectId;
}

type ToolCallFacts = {
  tool: string;
  projectId: string;
  success: boolean;
  durationMs: number;
  error?: string;
};

function emitToolCalled(session: McpSession, facts: ToolCallFacts): void {
  // Fire-and-forget: the enrichment lookups must not add latency to the tool
  // response, and an analytics failure must never surface to the MCP client.
  void captureToolCalled(session, facts).catch((err) => {
    log.debug({ err, tool: facts.tool }, "mcp analytics capture failed");
  });
}

async function captureToolCalled(session: McpSession, facts: ToolCallFacts): Promise<void> {
  const [user, [org]] = await Promise.all([
    db.query.users.findFirst({
      where: eq(schema.users.id, session.userId),
      columns: { email: true, name: true },
    }),
    db
      .select({
        id: schema.orgs.id,
        name: schema.orgs.name,
        slug: schema.orgs.slug,
      })
      .from(schema.projects)
      .innerJoin(schema.orgs, eq(schema.orgs.id, schema.projects.orgId))
      .where(eq(schema.projects.id, facts.projectId)),
  ]);

  captureServerEvent({
    distinctId: session.userId,
    event: "mcp_tool_called",
    properties: {
      tool: facts.tool,
      project_id: facts.projectId,
      org_id: org?.id,
      org_name: org?.name,
      org_slug: org?.slug,
      user_email: user?.email,
      token_kind: session.tokenKind,
      success: facts.success,
      duration_ms: Math.round(facts.durationMs),
      ...(facts.error === undefined ? {} : { error: facts.error.slice(0, MAX_ERROR_LENGTH) }),
    },
    set: user ? { email: user.email, name: user.name } : undefined,
  });
}
