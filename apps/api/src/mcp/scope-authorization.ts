import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type AnyToolHandler = (...args: unknown[]) => unknown;
type ToolConfig = {
  annotations?: { readOnlyHint?: boolean };
};
type AnyRegisterTool = (name: string, config: ToolConfig, handler: AnyToolHandler) => unknown;

export const READ_ONLY_TOOL = {
  readOnlyHint: true,
} as const;

const MCP_READ_SCOPE = "mcp:read";

export function resolveMcpOauthScope(
  requestedScope: string | null,
): { scope: typeof MCP_READ_SCOPE } | { error: string } {
  const requested = requestedScope?.split(/\s+/).filter(Boolean) ?? [];
  const unsupported = [...new Set(requested.filter((scope) => scope !== MCP_READ_SCOPE))];
  if (unsupported.length > 0) {
    return {
      error: `unsupported MCP scope${unsupported.length === 1 ? "" : "s"}: ${unsupported.join(", ")}`,
    };
  }
  return { scope: MCP_READ_SCOPE };
}

/**
 * Restrict an `mcp:read` session to tools explicitly classified as read-only.
 *
 * The default is intentionally deny: a newly added tool is unavailable to
 * read-scoped tokens until its registration opts in with READ_ONLY_TOOL.
 */
export function enforceMcpToolScopes(server: McpServer, scopes: readonly string[]): void {
  if (!scopes.includes(MCP_READ_SCOPE)) return;

  const original = (server.registerTool as AnyRegisterTool).bind(server);
  (server as unknown as { registerTool: AnyRegisterTool }).registerTool = (
    name,
    config,
    handler,
  ) => {
    if (config.annotations?.readOnlyHint !== true) return undefined;
    return original(name, config, handler);
  };
}
