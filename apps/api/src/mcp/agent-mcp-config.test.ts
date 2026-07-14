import "../project-mcp-test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClickHouseClient } from "@clickhouse/client";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAgentConfigTools } from "./agent-config.js";

test("the Superlog MCP exposes complete project MCP administration tools", () => {
  const names: string[] = [];
  const server = {
    registerTool(name: string) {
      names.push(name);
    },
  } as unknown as McpServer;

  registerAgentConfigTools(
    server,
    {
      userId: "user-1",
      activeProjectId: "00000000-0000-4000-8000-000000000001",
    },
    {} as ClickHouseClient,
  );

  assert.deepEqual(
    names.filter((name) => name.includes("agent_mcp")),
    [
      "list_agent_mcp_servers",
      "add_agent_mcp_server",
      "update_agent_mcp_server",
      "remove_agent_mcp_server",
      "start_agent_mcp_oauth",
      "connect_agent_mcp_client_credentials",
      "disconnect_agent_mcp_oauth",
      "test_agent_mcp_server",
    ],
  );
});
