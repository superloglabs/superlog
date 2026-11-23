import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, db, generateMcpRefreshToken, runMigrations, schema } from "@superlog/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { mountOauthDecision, mountOauthEndpoints } from "./oauth.js";

const cfg = {
  apiBaseUrl: "https://api.example.com",
  webOrigin: "https://app.example.com",
  resource: "https://api.example.com/mcp",
};

const orgIds: string[] = [];
const userIds: string[] = [];
const clientIds: string[] = [];

before(async () => {
  await runMigrations();
});

after(async () => {
  try {
    for (const orgId of orgIds.reverse()) {
      await db.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
    }
    for (const userId of userIds.reverse()) {
      await db.delete(schema.users).where(eq(schema.users.id, userId));
    }
    for (const clientId of clientIds.reverse()) {
      await db.delete(schema.mcpOauthClients).where(eq(schema.mcpOauthClients.id, clientId));
    }
  } finally {
    await closeDb();
  }
});

async function seedClient(name: string, redirectUris: string[]) {
  const [client] = await db
    .insert(schema.mcpOauthClients)
    .values({ name, redirectUris })
    .returning();
  if (!client) throw new Error("seed OAuth client failed");
  clientIds.push(client.id);
  return client;
}

async function seedUserProject() {
  const tag = `mcp-hardening-${randomUUID()}`;
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
  return { user, project };
}

async function seedToken(params: { clientId: string; userId: string; projectId: string }) {
  const refresh = generateMcpRefreshToken();
  const [token] = await db
    .insert(schema.mcpOauthTokens)
    .values({
      accessHash: `access-${randomUUID()}`,
      refreshHash: refresh.hash,
      ...params,
      resource: cfg.resource,
      scope: "mcp:read mcp:write",
      accessExpiresAt: new Date(Date.now() + 60_000),
      refreshExpiresAt: new Date(Date.now() + 120_000),
    })
    .returning();
  if (!token) throw new Error("seed token failed");
  return { token, refreshPlaintext: refresh.plaintext };
}

function tokenApp(): Hono {
  const app = new Hono();
  mountOauthEndpoints(app, cfg);
  return app;
}

function decisionApp(): Hono<{ Variables: { userId: string; orgId: string | null } }> {
  const app = new Hono<{ Variables: { userId: string; orgId: string | null } }>();
  mountOauthDecision(app, cfg);
  return app;
}

function refresh(app: Hono, clientId: string, refreshToken: string) {
  return app.request("/oauth/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    }),
  });
}

test("reusing a rotated refresh token revokes every token in the grant", async () => {
  const { user, project } = await seedUserProject();
  const client = await seedClient("Acme Widgets", ["http://127.0.0.1/callback"]);
  const { refreshPlaintext } = await seedToken({
    clientId: client.id,
    userId: user.id,
    projectId: project.id,
  });
  const app = tokenApp();

  const first = await refresh(app, client.id, refreshPlaintext);
  assert.equal(first.status, 200);
  const rotated = (await first.json()) as { refresh_token: string };

  const replay = await refresh(app, client.id, refreshPlaintext);
  assert.equal(replay.status, 400);
  assert.equal(((await replay.json()) as { error: string }).error, "invalid_grant");

  const live = await db.query.mcpOauthTokens.findMany({
    where: eq(schema.mcpOauthTokens.clientId, client.id),
  });
  assert.ok(live.length >= 2);
  assert.ok(live.every((row) => row.revokedAt !== null));

  const afterReplay = await refresh(app, client.id, rotated.refresh_token);
  assert.equal(afterReplay.status, 400);
});

test("a concurrent reuse that loses the rotation race revokes the grant", async () => {
  const { user, project } = await seedUserProject();
  const client = await seedClient("Acme Widgets", ["http://127.0.0.1/callback"]);
  const { refreshPlaintext } = await seedToken({
    clientId: client.id,
    userId: user.id,
    projectId: project.id,
  });
  const app = tokenApp();

  const results = await Promise.all([
    refresh(app, client.id, refreshPlaintext),
    refresh(app, client.id, refreshPlaintext),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);

  const rows = await db.query.mcpOauthTokens.findMany({
    where: eq(schema.mcpOauthTokens.clientId, client.id),
  });
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.revokedAt !== null));
});

test("reuse leaves the user's tokens for other clients alone", async () => {
  const { user, project } = await seedUserProject();
  const client = await seedClient("Acme Widgets", ["http://127.0.0.1/callback"]);
  const other = await seedClient("Acme Gadgets", ["http://127.0.0.1/other"]);
  const { refreshPlaintext } = await seedToken({
    clientId: client.id,
    userId: user.id,
    projectId: project.id,
  });
  const { token: otherToken } = await seedToken({
    clientId: other.id,
    userId: user.id,
    projectId: project.id,
  });
  const app = tokenApp();

  assert.equal((await refresh(app, client.id, refreshPlaintext)).status, 200);
  assert.equal((await refresh(app, client.id, refreshPlaintext)).status, 400);

  const otherRow = await db.query.mcpOauthTokens.findFirst({
    where: eq(schema.mcpOauthTokens.id, otherToken.id),
  });
  assert.equal(otherRow?.revokedAt, null);
});

test("client info shows the redirect target and flags borrowed names", async () => {
  const client = await seedClient("Claude Code", ["https://widgets.example/cb"]);
  const res = await decisionApp().request(
    `/api/mcp/oauth/client/${client.id}?redirect_uri=${encodeURIComponent("https://widgets.example/cb")}`,
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    id: client.id,
    name: "Unverified: Claude Code",
    verified: false,
    redirect: { kind: "web", target: "widgets.example", trusted: false },
  });
});

test("client info rejects a redirect URI the client did not register", async () => {
  const client = await seedClient("Acme Widgets", ["http://127.0.0.1/callback"]);
  const res = await decisionApp().request(
    `/api/mcp/oauth/client/${client.id}?redirect_uri=${encodeURIComponent("https://widgets.example/cb")}`,
  );
  assert.equal(res.status, 400);
});

function denyBody(clientId: string, redirectUri: string) {
  return JSON.stringify({
    client_id: clientId,
    redirect_uri: redirectUri,
    state: "s1",
    code_challenge: "challenge",
    code_challenge_method: "S256",
    resource: cfg.resource,
    decision: "deny",
  });
}

test("deny returns no redirect for an unverified web redirect", async () => {
  const client = await seedClient("Acme Widgets", ["https://widgets.example/cb"]);
  const res = await decisionApp().request("/api/mcp/oauth/decision", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: denyBody(client.id, "https://widgets.example/cb"),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { redirect_uri: null });
});

test("deny redirects a loopback client with access_denied", async () => {
  const client = await seedClient("Acme Widgets", ["http://127.0.0.1:4000/cb"]);
  const res = await decisionApp().request("/api/mcp/oauth/decision", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: denyBody(client.id, "http://127.0.0.1:4000/cb"),
  });
  assert.equal(res.status, 200);
  const { redirect_uri } = (await res.json()) as { redirect_uri: string };
  const url = new URL(redirect_uri);
  assert.equal(url.origin, "http://127.0.0.1:4000");
  assert.equal(url.searchParams.get("error"), "access_denied");
  assert.equal(url.searchParams.get("state"), "s1");
});

test("deny with an unregistered redirect URI is rejected without a redirect", async () => {
  const client = await seedClient("Acme Widgets", ["http://127.0.0.1:4000/cb"]);
  const res = await decisionApp().request("/api/mcp/oauth/decision", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: denyBody(client.id, "http://127.0.0.1:4001/cb"),
  });
  assert.equal(res.status, 400);
});
