import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import "../src/env.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { db, generateMcpAccessToken, hashToken, schema } from "@superlog/db";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { mountMcpPublic } from "../src/mcp/index.js";

const TEST_TAG = `mcp-agent-telemetry-${Date.now()}-${randomUUID().slice(0, 8)}`;
const API_BASE_URL = "http://mcp-agent-telemetry.test";

type QueryCall = {
  query: string;
  query_params: Record<string, unknown> | undefined;
};

function fakeClickHouse(calls: QueryCall[]) {
  return {
    query: async (opts: QueryCall) => {
      calls.push(opts);
      return {
        json: async () => [
          {
            ok: true,
            project_id: opts.query_params?.projectId,
            service: opts.query_params?.service ?? null,
          },
        ],
      };
    },
  };
}

async function callShouldFail(client: Client, name: string, args: Record<string, unknown>) {
  try {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, `${name} should have returned an MCP error`);
  } catch {
    // Some protocol/transport errors throw instead of returning an isError payload.
  }
}

async function main() {
  process.env.API_BASE_URL = API_BASE_URL;

  const calls: QueryCall[] = [];
  const app = new Hono();
  mountMcpPublic(app, fakeClickHouse(calls) as never);

  const userEmail = `${TEST_TAG}@example.com`;
  const [user] = await db
    .insert(schema.users)
    .values({ email: userEmail, clerkId: `clerk-${TEST_TAG}` })
    .returning();
  assert.ok(user);

  const [orgA, orgB] = await db
    .insert(schema.orgs)
    .values([
      { name: "MCP Agent Telemetry A", slug: `${TEST_TAG}-a` },
      { name: "MCP Agent Telemetry B", slug: `${TEST_TAG}-b` },
    ])
    .returning();
  assert.ok(orgA);
  assert.ok(orgB);

  const [projectA, projectB] = await db
    .insert(schema.projects)
    .values([
      { orgId: orgA.id, name: "Project A", slug: "default" },
      { orgId: orgB.id, name: "Project B", slug: "default" },
    ])
    .returning();
  assert.ok(projectA);
  assert.ok(projectB);

  await db.insert(schema.orgMembers).values([
    { orgId: orgA.id, userId: user.id, role: "member" },
    { orgId: orgB.id, userId: user.id, role: "member" },
  ]);

  const [mcpClient] = await db
    .insert(schema.mcpOauthClients)
    .values({
      name: `Managed agent run agent ${TEST_TAG}`,
      redirectUris: ["https://superlog.sh/managed-agent_runs/mcp/callback"],
      tokenEndpointAuthMethod: "none",
    })
    .returning();
  assert.ok(mcpClient);

  const token = generateMcpAccessToken();
  await db.insert(schema.mcpOauthTokens).values({
    accessHash: token.hash,
    refreshHash: null,
    clientId: mcpClient.id,
    userId: user.id,
    projectId: projectA.id,
    resource: `${API_BASE_URL}/mcp`,
    scope: `mcp:read superlog:telemetry superlog:org:${orgA.id}`,
    accessExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    refreshExpiresAt: null,
  });

  const transport = new StreamableHTTPClientTransport(new URL(`${API_BASE_URL}/mcp`), {
    requestInit: {
      headers: { authorization: `Bearer ${token.plaintext}` },
    },
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      return app.fetch(request);
    },
  });
  const client = new Client({ name: "mcp-agent-telemetry-test", version: "1.0.0" });

  try {
    await client.connect(transport);

    const tools = await client.listTools();
    const toolNames = new Set(tools.tools.map((tool) => tool.name));
    assert.equal(toolNames.has("query_logs"), true);
    assert.equal(toolNames.has("query_traces"), true);
    assert.equal(toolNames.has("query_metrics"), true);
    assert.equal(toolNames.has("list_services"), true);
    assert.equal(toolNames.has("create_alert"), false);
    assert.equal(toolNames.has("list_dashboards"), false);

    const projects = await client.callTool({ name: "list_projects", arguments: {} });
    assert.equal(projects.isError, undefined);
    assert.equal(projects.content[0]?.type, "text");
    const projectRows = JSON.parse(projects.content[0].text as string) as Array<{ id: string }>;
    assert.deepEqual(
      projectRows.map((row) => row.id),
      [projectA.id],
      "org-scoped token should only list projects from the target org",
    );

    const logs = await client.callTool({
      name: "query_logs",
      arguments: { service: "api", limit: 1 },
    });
    assert.equal(logs.isError, undefined);
    assert.equal(calls.at(-1)?.query_params?.projectId, projectA.id);

    await callShouldFail(client, "query_logs", { project_id: projectB.id, limit: 1 });
    await callShouldFail(client, "set_active_project", { project_id: projectB.id });

    console.log("ok: telemetry-only MCP token can query target org telemetry only");
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    await db
      .delete(schema.mcpOauthTokens)
      .where(eq(schema.mcpOauthTokens.accessHash, hashToken(token.plaintext)));
    await db.delete(schema.mcpOauthClients).where(eq(schema.mcpOauthClients.id, mcpClient.id));
    await db.delete(schema.orgs).where(inArray(schema.orgs.id, [orgA.id, orgB.id]));
    await db.delete(schema.users).where(eq(schema.users.id, user.id));
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
