import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type AnyToolHandler = (...args: unknown[]) => unknown;
type ToolConfig = {
  annotations?: { readOnlyHint?: boolean };
};
type AnyRegisterTool = (name: string, config: ToolConfig, handler: AnyToolHandler) => unknown;

export const READ_ONLY_TOOL = {
  readOnlyHint: true,
} as const;

export const MCP_READ_SCOPE = "mcp:read";
export const MCP_WRITE_SCOPE = "mcp:write";
export const MCP_SUPPORTED_SCOPES = [MCP_READ_SCOPE, MCP_WRITE_SCOPE] as const;
export const MCP_DEFAULT_SCOPE = MCP_SUPPORTED_SCOPES.join(" ");

type McpScopeResolution =
  | { scope: string }
  | {
      error: string;
      reason: "scope_escalation" | "unsupported_scope" | "write_requires_read";
    };

export function resolveMcpOauthScope(requestedScope: string | null): McpScopeResolution {
  const requested = requestedScope?.split(/\s+/).filter(Boolean) ?? [];
  const supported = new Set<string>(MCP_SUPPORTED_SCOPES);
  const unsupported = [...new Set(requested.filter((scope) => !supported.has(scope)))];
  if (unsupported.length > 0) {
    return {
      error: `unsupported MCP scope${unsupported.length === 1 ? "" : "s"}: ${unsupported.join(", ")}`,
      reason: "unsupported_scope",
    };
  }
  if (requested.includes(MCP_WRITE_SCOPE) && !requested.includes(MCP_READ_SCOPE)) {
    return {
      error: `${MCP_WRITE_SCOPE} requires ${MCP_READ_SCOPE}`,
      reason: "write_requires_read",
    };
  }
  if (requested.length === 0) return { scope: MCP_DEFAULT_SCOPE };
  return {
    scope: MCP_SUPPORTED_SCOPES.filter((scope) => requested.includes(scope)).join(" "),
  };
}

export function resolveStoredMcpOauthScope(
  storedScope: string | null,
): ReturnType<typeof resolveMcpOauthScope> {
  return resolveMcpOauthScope(
    isLegacyStoredMcpOauthScope(storedScope) ? MCP_READ_SCOPE : storedScope,
  );
}

export function isLegacyStoredMcpOauthScope(storedScope: string | null): boolean {
  return !storedScope?.trim();
}

export function resolveRefreshMcpOauthScope(
  requestedScope: string | null,
  storedScope: string | null,
): McpScopeResolution {
  const current = resolveStoredMcpOauthScope(storedScope);
  if ("error" in current || !requestedScope?.trim()) return current;

  const requested = resolveMcpOauthScope(requestedScope);
  if ("error" in requested) return requested;

  const currentScopes = new Set(current.scope.split(/\s+/));
  const expandedScopes = requested.scope.split(/\s+/).filter((scope) => !currentScopes.has(scope));
  if (expandedScopes.length > 0) {
    return {
      error: `requested refresh scope exceeds the original grant: ${expandedScopes.join(", ")}`,
      reason: "scope_escalation",
    };
  }
  return requested;
}

export function hasMcpWriteAccess(scopes: readonly string[]): boolean {
  return (
    scopes.length === 0 || (scopes.includes(MCP_READ_SCOPE) && scopes.includes(MCP_WRITE_SCOPE))
  );
}

/**
 * Restrict scoped sessions without the complete read/write grant to tools
 * explicitly classified as read-only. Empty scopes are legacy personal tokens
 * and intentionally retain full access.
 *
 * The default is intentionally deny: a newly added tool is unavailable to
 * read-scoped tokens until its registration opts in with READ_ONLY_TOOL.
 */
export function enforceMcpToolScopes(server: McpServer, scopes: readonly string[]): void {
  if (hasMcpWriteAccess(scopes)) return;

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
