import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ProjectMcpServer, ProjectMcpServerRepository } from "@superlog/db";
import { assertPublicHttpsUrl } from "./project-mcp-relay.js";

export async function testProjectMcpServerConnection(input: {
  projectId: string;
  serverId: string;
  repository: Pick<ProjectMcpServerRepository, "get">;
  ensureFreshOAuth: (projectId: string, serverId: string) => Promise<ProjectMcpServer>;
}): Promise<{ toolCount: number; tools: string[] }> {
  let server = await input.repository.get(input.projectId, input.serverId);
  if (!server) throw new Error("MCP server not found");
  if (server.auth.type === "oauth") {
    server = await input.ensureFreshOAuth(input.projectId, input.serverId);
  }
  const endpoint = new URL(server.url);
  await assertPublicHttpsUrl(endpoint);
  const headers = new Headers();
  if (server.auth.type === "bearer") {
    headers.set("authorization", `Bearer ${server.auth.token}`);
  } else if (server.auth.type === "api_key") {
    headers.set(server.auth.headerName, server.auth.key);
  } else if (server.auth.type === "oauth" && server.auth.accessToken) {
    headers.set("authorization", `Bearer ${server.auth.accessToken}`);
  }
  const client = new Client({
    name: "superlog-mcp-connection-test",
    version: "1.0.0",
  });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    },
  });
  try {
    await client.connect(transport);
    const response = await client.listTools();
    return {
      toolCount: response.tools.length,
      tools: response.tools.map((tool) => tool.name),
    };
  } finally {
    await client.close().catch(() => {});
  }
}
