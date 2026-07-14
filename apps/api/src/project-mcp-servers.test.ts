import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import {
  MAX_ENABLED_CUSTOM_MCP_SERVERS,
  ProjectMcpServerError,
  closeDb,
  createDrizzleProjectMcpServerRepository,
  createProjectMcpServerManager,
  db,
  runMigrations,
  schema,
} from "@superlog/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import {
  mountProjectMcpServersAuthed,
  mountProjectMcpServersManagement,
  parseProjectMcpServerAuthInput,
} from "./project-mcp-servers.js";

process.env.AGENT_SECRETS_KEY ||= randomBytes(32).toString("base64");

type Vars = { userId: string; orgId: string | null };
const orgIds: string[] = [];

before(async () => runMigrations());
after(async () => {
  try {
    for (const orgId of orgIds.reverse())
      await db.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
  } finally {
    await closeDb();
  }
});

async function seedProject(role: "owner" | "member" = "owner") {
  const tag = `mcp-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const [org] = await db.insert(schema.orgs).values({ name: tag, slug: tag }).returning();
  if (!org) throw new Error("seed org failed");
  orgIds.push(org.id);
  const [user] = await db
    .insert(schema.users)
    .values({ email: `${tag}@example.com` })
    .returning();
  if (!user) throw new Error("seed user failed");
  await db.insert(schema.orgMembers).values({ orgId: org.id, userId: user.id, role });
  const [project] = await db
    .insert(schema.projects)
    .values({ orgId: org.id, name: "test", slug: tag })
    .returning();
  if (!project) throw new Error("seed project failed");
  return { org, user, project };
}

test("OAuth authentication rejects unknown grant types", () => {
  assert.throws(
    () =>
      parseProjectMcpServerAuthInput({
        type: "oauth",
        grantType: "password",
      }),
    (error: unknown) => error instanceof ProjectMcpServerError && error.code === "invalid_auth",
  );
});

test("an owner can configure bearer and API-key MCPs without credentials leaking", async () => {
  const { org, user, project } = await seedProject();
  const app = new Hono<{ Variables: Vars }>();
  app.use("*", (c, next) => {
    c.set("userId", user.id);
    c.set("orgId", org.id);
    return next();
  });
  mountProjectMcpServersAuthed(app);

  for (const body of [
    {
      name: "linear",
      url: "https://linear.example/mcp",
      auth: { type: "bearer", token: "bearer-secret" },
      confirmTrusted: true,
    },
    {
      name: "internal_api",
      url: "https://internal.example/mcp",
      auth: { type: "api_key", headerName: "X-API-Key", key: "api-key-secret" },
      confirmTrusted: true,
    },
  ]) {
    const response = await app.request(`/api/org/projects/${project.id}/agent-mcp-servers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 201);
    const text = await response.text();
    assert.equal(text.includes("bearer-secret"), false);
    assert.equal(text.includes("api-key-secret"), false);
  }

  const listed = await app.request(`/api/org/projects/${project.id}/agent-mcp-servers`);
  const text = await listed.text();
  assert.equal(listed.status, 200);
  assert.equal(text.includes("bearer-secret"), false);
  assert.equal(text.includes("api-key-secret"), false);
  assert.match(text, /X-API-Key/);
});

test("the management API exposes project MCP CRUD without returning secrets", async () => {
  const { org, project } = await seedProject();
  const app = new Hono<{ Variables: { managementOrgId: string } }>();
  app.use("*", (c, next) => {
    c.set("managementOrgId", org.id);
    return next();
  });
  mountProjectMcpServersManagement(app);

  const created = await app.request(`/api/v1/projects/${project.id}/agent-mcp-servers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "notion",
      url: "https://notion.example/mcp",
      auth: { type: "bearer", token: "management-secret" },
      confirmTrusted: true,
    }),
  });
  assert.equal(created.status, 201);
  const createdPayload = (await created.json()) as { server: { id: string } };
  assert.equal(JSON.stringify(createdPayload).includes("management-secret"), false);

  const updated = await app.request(
    `/api/v1/projects/${project.id}/agent-mcp-servers/${createdPayload.server.id}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    },
  );
  assert.equal(updated.status, 200);

  const removed = await app.request(
    `/api/v1/projects/${project.id}/agent-mcp-servers/${createdPayload.server.id}`,
    { method: "DELETE" },
  );
  assert.equal(removed.status, 200);
});

test("concurrent creates cannot exceed the nineteen custom-server provider slots", async () => {
  const { user, project } = await seedProject();
  const manager = createProjectMcpServerManager(createDrizzleProjectMcpServerRepository());
  const results = await Promise.allSettled(
    Array.from({ length: MAX_ENABLED_CUSTOM_MCP_SERVERS + 1 }, (_, index) =>
      manager.add({
        projectId: project.id,
        actorUserId: user.id,
        name: `server_${index}`,
        url: `https://server-${index}.example/mcp`,
        enabled: true,
        auth: { type: "none" },
        confirmTrusted: true,
      }),
    ),
  );

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 19);
  const rejected = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0]?.reason instanceof ProjectMcpServerError);
  assert.equal((rejected[0]?.reason as ProjectMcpServerError).code, "enabled_limit");
});
