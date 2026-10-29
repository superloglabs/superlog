import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, afterEach, before, mock, test } from "node:test";
import type { ClickHouseClient } from "@clickhouse/client";
import { closeDb, db, hashToken, runMigrations, schema } from "@superlog/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import {
  createCutOverLookup,
  forwardMcpRequest,
  mcpForwardAccess,
  workspaceMcpEndpoint,
} from "./forwarding.js";
import { mountMcpPublic } from "./index.js";

const orgIds: string[] = [];
const userIds: string[] = [];
const clientIds: string[] = [];

before(async () => {
  await runMigrations();
});

afterEach(() => {
  mock.restoreAll();
  Reflect.deleteProperty(process.env, "LEGACY_MCP_FORWARD_TOKEN");
});

after(async () => {
  try {
    for (const orgId of orgIds) await db.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
    for (const userId of userIds) await db.delete(schema.users).where(eq(schema.users.id, userId));
    for (const clientId of clientIds) {
      await db.delete(schema.mcpOauthClients).where(eq(schema.mcpOauthClients.id, clientId));
    }
  } finally {
    await closeDb();
  }
});

test("caches whether a project is cut over, including when it is not", async () => {
  let clock = 0;
  const answers = new Map<string, string | null>([["moved", "https://us.example.com"]]);
  const loads: string[] = [];
  const lookup = createCutOverLookup(
    async (projectId) => {
      loads.push(projectId);
      return answers.get(projectId) ?? null;
    },
    { ttlMs: 30_000, now: () => clock },
  );

  assert.equal(await lookup("moved"), "https://us.example.com");
  assert.equal(await lookup("stayed"), null);
  answers.set("stayed", "https://us.example.com");
  clock = 29_999;
  assert.equal(await lookup("moved"), "https://us.example.com");
  assert.equal(await lookup("stayed"), null);
  assert.deepEqual(loads, ["moved", "stayed"]);

  clock = 30_000;
  assert.equal(await lookup("stayed"), "https://us.example.com");
  assert.deepEqual(loads, ["moved", "stayed", "stayed"]);
});

test("forwards read-only access unless the token has the full grant", () => {
  assert.equal(mcpForwardAccess("mcp:read mcp:write", false), "read-write");
  assert.equal(mcpForwardAccess("mcp:read", false), "read");
  assert.equal(mcpForwardAccess("mcp:read mcp:write superlog:telemetry", true), "read");
  // Personal access tokens without a scope keep full access, as they do here.
  assert.equal(mcpForwardAccess(null, false), "read-write");
});

test("sends the credential only to an HTTPS workspace origin or localhost", () => {
  assert.equal(
    workspaceMcpEndpoint("https://us.example.com")?.toString(),
    "https://us.example.com/api/mcp",
  );
  assert.equal(
    workspaceMcpEndpoint("https://us.example.com/somewhere?x=1")?.toString(),
    "https://us.example.com/api/mcp",
  );
  assert.equal(
    workspaceMcpEndpoint("http://localhost:3000")?.toString(),
    "http://localhost:3000/api/mcp",
  );
  assert.equal(workspaceMcpEndpoint("http://us.example.com"), null);
  assert.equal(workspaceMcpEndpoint("https://user:pass@us.example.com"), null);
  assert.equal(workspaceMcpEndpoint("not a url"), null);
});

test("forwards the JSON-RPC body unchanged and streams the answer back", async () => {
  const body = JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list" });
  let sent: { url: string; init: RequestInit } | undefined;
  const send = async (url: string | URL | Request, init?: RequestInit) => {
    sent = { url: String(url), init: init ?? {} };
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0",'));
        controller.enqueue(new TextEncoder().encode('"id":1,"result":{}}'));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "set-cookie": "session=1",
        "www-authenticate": "Bearer realm=other",
      },
    });
  };

  const response = await forwardMcpRequest(
    new Request("https://api.example.com/mcp", {
      method: "POST",
      body,
      headers: {
        accept: "application/json, text/event-stream",
        authorization: "Bearer old-token",
        "content-type": "application/json",
        cookie: "session=old",
        "mcp-protocol-version": "2025-06-18",
      },
    }),
    {
      access: "read",
      credential: "forward-secret",
      email: "ash@example.com",
      endpoint: new URL("https://us.example.com/api/mcp"),
      projectId: "11111111-1111-4111-8111-111111111111",
    },
    send as typeof fetch,
  );

  assert.ok(sent);
  assert.equal(sent.url, "https://us.example.com/api/mcp");
  assert.equal(sent.init.method, "POST");
  assert.equal(new TextDecoder().decode(sent.init.body as ArrayBuffer), body);
  assert.deepEqual(Object.fromEntries(new Headers(sent.init.headers).entries()), {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": "2025-06-18",
    "x-legacy-mcp-access": "read",
    "x-legacy-mcp-forward-token": "forward-secret",
    "x-legacy-mcp-project-id": "11111111-1111-4111-8111-111111111111",
    "x-legacy-mcp-user-email": "ash@example.com",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(Object.fromEntries(response.headers.entries()), {
    "content-type": "application/json",
  });
  assert.equal(await response.text(), '{"jsonrpc":"2.0","id":1,"result":{}}');
});

async function seedToken(input: { cutOverAt?: Date | null; scope?: string } = {}) {
  const tag = `mcp-forward-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const [user] = await db
    .insert(schema.users)
    .values({ email: `${tag}@example.com` })
    .returning();
  if (!user) throw new Error("seed user failed");
  userIds.push(user.id);
  const [org] = await db.insert(schema.orgs).values({ name: tag, slug: tag }).returning();
  if (!org) throw new Error("seed org failed");
  orgIds.push(org.id);
  await db.insert(schema.orgMembers).values({ orgId: org.id, userId: user.id, role: "owner" });
  const [project] = await db
    .insert(schema.projects)
    .values({ orgId: org.id, name: "Default", slug: "default" })
    .returning();
  if (!project) throw new Error("seed project failed");
  const [client] = await db
    .insert(schema.mcpOauthClients)
    .values({ name: tag, redirectUris: ["http://127.0.0.1/callback"] })
    .returning();
  if (!client) throw new Error("seed OAuth client failed");
  clientIds.push(client.id);

  const token = `mcp_${randomBytes(24).toString("hex")}`;
  await db.insert(schema.mcpOauthTokens).values({
    accessHash: hashToken(token),
    clientId: client.id,
    userId: user.id,
    projectId: project.id,
    resource: "http://localhost:4100/mcp",
    scope: input.scope ?? "mcp:read mcp:write",
    accessExpiresAt: new Date(Date.now() + 60_000),
  });
  if (input.cutOverAt !== undefined) {
    await db.insert(schema.projectMigrations).values({
      projectId: project.id,
      workspaceUrl: "https://us.example.com",
      cutOverAt: input.cutOverAt,
    });
  }
  return { email: user.email, projectId: project.id, token };
}

function mcpApp() {
  const app = new Hono();
  mountMcpPublic(app, {} as ClickHouseClient);
  return app;
}

function initialize(app: Hono, token: string) {
  return app.request("/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
        protocolVersion: "2025-06-18",
      },
    }),
  });
}

function stubWorkspace() {
  return mock.method(globalThis, "fetch", async () =>
    Response.json({
      id: 1,
      jsonrpc: "2.0",
      result: { serverInfo: { name: "superlog", version: "workspace" } },
    }),
  );
}

test("serves projects that are not cut over here", async () => {
  process.env.LEGACY_MCP_FORWARD_TOKEN = "forward-secret";
  const fetch = stubWorkspace();
  const app = mcpApp();

  for (const seeded of [await seedToken(), await seedToken({ cutOverAt: null })]) {
    const response = await initialize(app, seeded.token);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /"version":"0\.1\.0"/);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("forwards a cut-over project's requests as the token owner", async () => {
  process.env.LEGACY_MCP_FORWARD_TOKEN = "forward-secret";
  const fetch = stubWorkspace();
  const seeded = await seedToken({ cutOverAt: new Date(), scope: "mcp:read" });

  const response = await initialize(mcpApp(), seeded.token);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    id: 1,
    jsonrpc: "2.0",
    result: { serverInfo: { name: "superlog", version: "workspace" } },
  });
  assert.equal(fetch.mock.callCount(), 1);
  const [url, init] = fetch.mock.calls[0]?.arguments as [URL, RequestInit];
  assert.equal(url.toString(), "https://us.example.com/api/mcp");
  const headers = new Headers(init.headers);
  assert.equal(headers.get("authorization"), null);
  assert.equal(headers.get("x-legacy-mcp-forward-token"), "forward-secret");
  assert.equal(headers.get("x-legacy-mcp-project-id"), seeded.projectId);
  assert.equal(headers.get("x-legacy-mcp-user-email"), seeded.email);
  assert.equal(headers.get("x-legacy-mcp-access"), "read");
});

test("refuses a cut-over project's requests when forwarding is not configured", async () => {
  const fetch = stubWorkspace();
  const seeded = await seedToken({ cutOverAt: new Date() });

  const response = await initialize(mcpApp(), seeded.token);

  assert.equal(response.status, 503);
  assert.equal(fetch.mock.callCount(), 0);
});

test("still rejects an unknown token before looking for a cutover", async () => {
  process.env.LEGACY_MCP_FORWARD_TOKEN = "forward-secret";
  const fetch = stubWorkspace();

  const response = await initialize(mcpApp(), "mcp_unknown");

  assert.equal(response.status, 401);
  assert.equal(fetch.mock.callCount(), 0);
});
