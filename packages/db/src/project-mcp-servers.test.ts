import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ProjectMcpServer,
  type ProjectMcpServerRepository,
  createProjectMcpServerManager,
} from "./project-mcp-servers.js";

class InMemoryProjectMcpServerRepository implements ProjectMcpServerRepository {
  private rows: ProjectMcpServer[] = [];

  async list(projectId: string): Promise<ProjectMcpServer[]> {
    return this.rows.filter((row) => row.projectId === projectId);
  }

  async get(projectId: string, id: string): Promise<ProjectMcpServer | null> {
    return this.rows.find((row) => row.projectId === projectId && row.id === id) ?? null;
  }

  async insert(input: Omit<ProjectMcpServer, "id" | "createdAt" | "updatedAt">) {
    const now = new Date("2026-07-14T10:00:00.000Z");
    const row: ProjectMcpServer = {
      ...input,
      id: `mcp-${this.rows.length + 1}`,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.push(row);
    return row;
  }

  async update(server: ProjectMcpServer): Promise<ProjectMcpServer> {
    const index = this.rows.findIndex((row) => row.id === server.id);
    if (index < 0) throw new Error("not found");
    this.rows[index] = server;
    return server;
  }

  async delete(projectId: string, id: string): Promise<boolean> {
    const before = this.rows.length;
    this.rows = this.rows.filter((row) => row.projectId !== projectId || row.id !== id);
    return this.rows.length < before;
  }
}

test("a project can add a bearer-authenticated MCP without exposing its credential", async () => {
  const manager = createProjectMcpServerManager(new InMemoryProjectMcpServerRepository());

  const created = await manager.add({
    projectId: "project-1",
    actorUserId: "user-1",
    name: "linear",
    url: "https://mcp.linear.example/mcp",
    enabled: true,
    auth: { type: "bearer", token: "secret-bearer" },
    confirmTrusted: true,
  });

  assert.equal(created.auth.type, "bearer");
  assert.equal(created.auth.hasCredential, true);
  assert.equal(JSON.stringify(created).includes("secret-bearer"), false);
  assert.equal(JSON.stringify(await manager.list("project-1")).includes("secret-bearer"), false);
});

test("API-key authentication only accepts a safe custom header", async () => {
  const manager = createProjectMcpServerManager(new InMemoryProjectMcpServerRepository());

  await assert.rejects(
    manager.add({
      projectId: "project-1",
      actorUserId: "user-1",
      name: "unsafe",
      url: "https://mcp.example/mcp",
      auth: {
        type: "api_key",
        headerName: "Authorization",
        key: "api-secret",
        relayToken: "relay-secret",
      },
      confirmTrusted: true,
    }),
    /header/i,
  );
});

test("editing preserves a credential unless authentication is explicitly replaced", async () => {
  const repository = new InMemoryProjectMcpServerRepository();
  const manager = createProjectMcpServerManager(repository);
  const created = await manager.add({
    projectId: "project-1",
    actorUserId: "user-1",
    name: "github",
    url: "https://github.example/mcp",
    auth: { type: "bearer", token: "secret-bearer" },
    confirmTrusted: true,
  });

  const renamed = await manager.update({
    projectId: "project-1",
    id: created.id,
    actorUserId: "user-1",
    name: "github_cloud",
  });
  assert.deepEqual(renamed.auth, { type: "bearer", hasCredential: true });

  const disconnected = await manager.update({
    projectId: "project-1",
    id: created.id,
    actorUserId: "user-1",
    auth: { type: "none" },
  });
  assert.deepEqual(disconnected.auth, { type: "none", hasCredential: false });
});

test("equivalent endpoint URL spellings cannot create duplicate MCP servers", async () => {
  const manager = createProjectMcpServerManager(new InMemoryProjectMcpServerRepository());
  const created = await manager.add({
    projectId: "project-1",
    actorUserId: "user-1",
    name: "first",
    url: "https://MCP.EXAMPLE:443",
    auth: { type: "none" },
    confirmTrusted: true,
  });

  assert.equal(created.url, "https://mcp.example/");
  await assert.rejects(
    manager.add({
      projectId: "project-1",
      actorUserId: "user-1",
      name: "second",
      url: "https://mcp.example/",
      auth: { type: "none" },
      confirmTrusted: true,
    }),
    /URL already exists/i,
  );
});
