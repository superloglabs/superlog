import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { ClickHouseClient } from "@clickhouse/client";
import {
  closeDb,
  db,
  generatePersonalAccessToken,
  hashToken,
  runMigrations,
  schema,
} from "@superlog/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { mountMcpPublic } from "./index.js";

// MCP credentials belong to one user. While that user is banned, none of
// them may be used: not an access token, not a personal access token, and
// not a refresh token or authorization code exchanged for new tokens.

const resource = "http://localhost:4100/mcp";
const redirectUri = "http://127.0.0.1/callback";
const codeVerifier = "mcp-oauth-code-verifier-with-sufficient-entropy";

const orgIds: string[] = [];
const userIds: string[] = [];
const clientIds: string[] = [];

before(async () => {
  await runMigrations();
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

async function seedGrant() {
  const tag = `mcp-ban-${randomUUID()}`;
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
    .values({ name: tag, redirectUris: [redirectUri] })
    .returning();
  if (!client) throw new Error("seed OAuth client failed");
  clientIds.push(client.id);

  const accessToken = `mcp_${randomBytes(24).toString("hex")}`;
  const refreshToken = `mcp_rt_${randomBytes(24).toString("hex")}`;
  await db.insert(schema.mcpOauthTokens).values({
    accessHash: hashToken(accessToken),
    refreshHash: hashToken(refreshToken),
    clientId: client.id,
    userId: user.id,
    projectId: project.id,
    resource,
    scope: "mcp:read mcp:write",
    accessExpiresAt: new Date(Date.now() + 60_000),
    refreshExpiresAt: new Date(Date.now() + 120_000),
  });

  const pat = generatePersonalAccessToken();
  await db.insert(schema.personalAccessTokens).values({
    userId: user.id,
    projectId: project.id,
    name: "laptop",
    tokenPrefix: pat.prefix,
    tokenHash: pat.hash,
  });

  const code = randomUUID();
  await db.insert(schema.mcpOauthCodes).values({
    code,
    clientId: client.id,
    userId: user.id,
    projectId: project.id,
    redirectUri,
    codeChallenge: createHash("sha256").update(codeVerifier).digest("base64url"),
    codeChallengeMethod: "S256",
    resource,
    expiresAt: new Date(Date.now() + 60_000),
  });

  return {
    userId: user.id,
    clientId: client.id,
    accessToken,
    refreshToken,
    pat: pat.plaintext,
    code,
  };
}

async function banUser(userId: string) {
  await db.update(schema.users).set({ banned: true }).where(eq(schema.users.id, userId));
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

function tokenRequest(app: Hono, fields: Record<string, string>) {
  return app.request("/oauth/token", { method: "POST", body: new URLSearchParams(fields) });
}

test("MCP access tokens and personal access tokens stop working while the user is banned", async () => {
  const grant = await seedGrant();
  const app = mcpApp();
  assert.equal((await initialize(app, grant.accessToken)).status, 200);
  assert.equal((await initialize(app, grant.pat)).status, 200);

  await banUser(grant.userId);

  assert.equal((await initialize(app, grant.accessToken)).status, 401);
  assert.equal((await initialize(app, grant.pat)).status, 401);
});

test("a banned user's refresh token cannot be exchanged", async () => {
  const grant = await seedGrant();
  await banUser(grant.userId);

  const response = await tokenRequest(mcpApp(), {
    grant_type: "refresh_token",
    refresh_token: grant.refreshToken,
    client_id: grant.clientId,
  });

  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as { error: string }).error, "invalid_grant");
});

test("a banned user's authorization code cannot be exchanged", async () => {
  const grant = await seedGrant();
  await banUser(grant.userId);

  const response = await tokenRequest(mcpApp(), {
    grant_type: "authorization_code",
    code: grant.code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
    client_id: grant.clientId,
  });

  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as { error: string }).error, "invalid_grant");
});
