import "../project-mcp-test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClickHouseClient } from "@clickhouse/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { resolveMcpOauthScope, resolveStoredMcpOauthScope } from "./scope-authorization.js";
import { createMcpServerForSession } from "./server.js";

const fakeCh = {} as ClickHouseClient;

async function connectedClient(
  session: Parameters<typeof createMcpServerForSession>[0],
): Promise<Client> {
  const server = createMcpServerForSession({
    ...session,
    ch: fakeCh,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "scope-test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const session = {
  ch: fakeCh,
  userId: "00000000-0000-4000-8000-000000000001",
  tokenId: "scope-test-token",
  tokenKind: "oauth" as const,
  activeProjectId: "00000000-0000-4000-8000-000000000002",
};

test("OAuth defaults to read and write access when the client omits scopes", () => {
  assert.deepEqual(resolveMcpOauthScope(null), { scope: "mcp:read mcp:write" });
});

test("legacy OAuth tokens stored without a scope remain read-only", () => {
  assert.deepEqual(resolveStoredMcpOauthScope(null), { scope: "mcp:read" });
});

test("legacy OAuth tokens stored with a blank scope remain read-only", () => {
  assert.deepEqual(resolveStoredMcpOauthScope("   "), { scope: "mcp:read" });
});

test("OAuth accepts read and write scopes", () => {
  assert.deepEqual(resolveMcpOauthScope("  mcp:write   mcp:read  "), {
    scope: "mcp:read mcp:write",
  });
});

test("OAuth write access requires read access", () => {
  assert.deepEqual(resolveMcpOauthScope("mcp:write"), {
    error: "mcp:write requires mcp:read",
    reason: "write_requires_read",
  });
});

test("OAuth rejects unsupported scopes", () => {
  assert.deepEqual(resolveMcpOauthScope("mcp:read profile"), {
    error: "unsupported MCP scope: profile",
    reason: "unsupported_scope",
  });
});

test("mcp:read sessions expose reads but not writes or deletes", async () => {
  const client = await connectedClient({ ...session, scopes: ["mcp:read"] });
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();

  assert.deepEqual(names, [
    "get_active_project",
    "get_alert",
    "get_dashboard",
    "get_incident",
    "get_issue_filter",
    "get_project_context",
    "list_agent_mcp_servers",
    "list_agent_memories",
    "list_alerts",
    "list_dashboards",
    "list_projects",
    "list_services",
    "preview_alert",
    "preview_issue_filter",
    "query_logs",
    "query_metrics",
    "query_traces",
    "search_incidents",
    "test_alert",
  ]);
});

test("mcp:read sessions do not instruct clients to call unavailable write tools", async () => {
  const client = await connectedClient({ ...session, scopes: ["mcp:read"] });
  const instructions = client.getInstructions() ?? "";

  assert.match(instructions, /read-only/i);
  assert.doesNotMatch(instructions, /create_agent_memory/);
  assert.doesNotMatch(instructions, /set_project_context/);
  assert.doesNotMatch(instructions, /update_issue_filter/);
});

test("mcp:read sessions reject direct calls to mutation tools", async () => {
  const client = await connectedClient({ ...session, scopes: ["mcp:read"] });

  const result = await client.callTool({
    name: "delete_agent_memory",
    arguments: {
      id: "00000000-0000-4000-8000-000000000003",
    },
  });

  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /not found/i);
});

test("mcp:write sessions expose project authoring tools", async () => {
  const client = await connectedClient({
    ...session,
    scopes: ["mcp:read", "mcp:write"],
  });
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name);

  assert.ok(names.includes("create_agent_memory"));
  assert.ok(names.includes("set_project_context"));
  assert.ok(names.includes("update_issue_filter"));
  assert.ok(names.includes("create_alert"));

  const instructions = client.getInstructions() ?? "";
  for (const name of ["create_agent_memory", "set_project_context", "update_issue_filter"]) {
    assert.match(instructions, new RegExp(name));
  }
});

test("unscoped personal tokens retain full MCP tool access", async () => {
  const client = await connectedClient({
    ...session,
    tokenKind: "pat",
    scopes: [],
  });
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name);

  assert.ok(names.includes("query_logs"));
  assert.ok(names.includes("create_agent_memory"));
  assert.ok(names.includes("delete_agent_memory"));
});
