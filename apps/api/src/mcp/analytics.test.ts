import "dotenv/config";
import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import type { ClickHouseClient } from "@clickhouse/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { closeDb, db, runMigrations, schema, setAnalyticsClientForTests } from "@superlog/db";
import { eq } from "drizzle-orm";
import { createMcpServerForSession } from "./server.js";

type CapturedEvent = { distinctId: string; event: string; properties?: Record<string, unknown> };

const captured: CapturedEvent[] = [];
const orgIds: string[] = [];
const userIds: string[] = [];

before(async () => {
  await runMigrations();
  setAnalyticsClientForTests({ capture: (e) => captured.push(e) });
});
after(async () => {
  setAnalyticsClientForTests(undefined);
  try {
    for (const orgId of orgIds.reverse()) {
      await db.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
    }
    for (const userId of userIds.reverse()) {
      await db.delete(schema.users).where(eq(schema.users.id, userId));
    }
  } finally {
    await closeDb();
  }
});

function uniq(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

async function seedUserWithProject() {
  const tag = uniq("mcpan");
  const [user] = await db
    .insert(schema.users)
    .values({ email: `${tag}@example.com`, name: "MCP Analytics Tester" })
    .returning();
  if (!user) throw new Error("seed user failed");
  userIds.push(user.id);
  const [org] = await db.insert(schema.orgs).values({ name: `Org ${tag}`, slug: tag }).returning();
  if (!org) throw new Error("seed org failed");
  orgIds.push(org.id);
  await db.insert(schema.orgMembers).values({ orgId: org.id, userId: user.id, role: "owner" });
  const [project] = await db
    .insert(schema.projects)
    .values({ orgId: org.id, name: "Default", slug: "default" })
    .returning();
  if (!project) throw new Error("seed project failed");
  return { user, org, project };
}

// list_projects / get_active_project never touch ClickHouse, so a throwing stub
// both satisfies the type and proves analytics never rides on a CH query.
const fakeCh = {
  query: () => {
    throw new Error("clickhouse should not be reached by this test");
  },
} as unknown as ClickHouseClient;

async function connectedClient(session: Parameters<typeof createMcpServerForSession>[0]) {
  const server = createMcpServerForSession(session);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function waitForEvent(
  predicate: (e: CapturedEvent) => boolean,
  timeoutMs = 3000,
): Promise<CapturedEvent> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = captured.find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for analytics event; captured=${JSON.stringify(captured)}`);
}

test("tool calls emit mcp_tool_called with user + org context", async () => {
  const { user, org, project } = await seedUserWithProject();
  const client = await connectedClient({
    ch: fakeCh,
    userId: user.id,
    tokenId: "tok-analytics-1",
    tokenKind: "pat",
    activeProjectId: project.id,
  });

  const result = await client.callTool({ name: "list_projects", arguments: {} });
  assert.equal(result.isError ?? false, false);

  const event = await waitForEvent(
    (e) => e.event === "mcp_tool_called" && e.properties?.tool === "list_projects",
  );
  assert.equal(event.distinctId, user.id);
  assert.equal(event.properties?.project_id, project.id);
  assert.equal(event.properties?.org_id, org.id);
  assert.equal(event.properties?.org_name, org.name);
  assert.equal(event.properties?.org_slug, org.slug);
  assert.equal(event.properties?.user_email, user.email);
  assert.equal(event.properties?.token_kind, "pat");
  assert.equal(event.properties?.success, true);
  assert.equal(typeof event.properties?.duration_ms, "number");
});

test("failed tool calls emit mcp_tool_called with success=false and the error", async () => {
  const { user } = await seedUserWithProject();
  const outsideProject = "00000000-0000-4000-8000-000000000000";
  const client = await connectedClient({
    ch: fakeCh,
    userId: user.id,
    tokenId: "tok-analytics-2",
    tokenKind: "oauth",
    activeProjectId: outsideProject,
  });

  const result = await client.callTool({ name: "get_active_project", arguments: {} });
  // get_active_project succeeds even when the active project is unknown; use a
  // tool that enforces access instead.
  assert.equal(result.isError ?? false, false);

  const failed = await client.callTool({
    name: "query_logs",
    arguments: { project_id: outsideProject },
  });
  assert.equal(failed.isError, true);

  const event = await waitForEvent(
    (e) => e.event === "mcp_tool_called" && e.properties?.tool === "query_logs",
  );
  assert.equal(event.distinctId, user.id);
  assert.equal(event.properties?.success, false);
  assert.equal(event.properties?.token_kind, "oauth");
  assert.match(String(event.properties?.error), /project/i);
  assert.equal(event.properties?.project_id, outsideProject);
});
