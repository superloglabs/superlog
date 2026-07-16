import "../project-mcp-test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDashboardTools } from "./dashboards.js";

test("the project MCP exposes complete home customization tools", () => {
  const names: string[] = [];
  const server = {
    registerTool(name: string) {
      names.push(name);
    },
  } as unknown as McpServer;

  registerDashboardTools(server, {
    userId: "user-1",
    activeProjectId: "00000000-0000-4000-8000-000000000001",
  });

  assert.deepEqual(
    names.filter((name) => name.includes("home")),
    [
      "get_home",
      "set_home_builtin",
      "add_home_widget",
      "add_home_link",
      "update_home_layout",
      "remove_home_item",
    ],
  );
});
