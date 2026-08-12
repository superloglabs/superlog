import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, db, runMigrations, schema } from "@superlog/db";
import { eq } from "drizzle-orm";
import { rotateMcpOauthRefreshToken } from "./oauth.js";

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

async function seedRefreshToken() {
  const tag = `mcp-refresh-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
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

  const [token] = await db
    .insert(schema.mcpOauthTokens)
    .values({
      accessHash: `${tag}-access`,
      refreshHash: `${tag}-refresh`,
      clientId: client.id,
      userId: user.id,
      projectId: project.id,
      resource: "https://api.example.com/mcp",
      scope: "mcp:read mcp:write",
      accessExpiresAt: new Date(Date.now() + 60_000),
      refreshExpiresAt: new Date(Date.now() + 120_000),
    })
    .returning();
  if (!token) throw new Error("seed OAuth token failed");

  return {
    token,
    params: {
      tokenId: token.id,
      clientId: client.id,
      userId: user.id,
      projectId: project.id,
      resource: token.resource,
      scope: token.scope,
    },
  };
}

test("only one concurrent refresh can claim and replace a token", async () => {
  const { params } = await seedRefreshToken();
  const rotations = await Promise.all([
    rotateMcpOauthRefreshToken(params),
    rotateMcpOauthRefreshToken(params),
  ]);

  assert.equal(rotations.filter(Boolean).length, 1);
});

test("failed replacement issuance rolls back the refresh-token claim", async () => {
  const { token, params } = await seedRefreshToken();

  await assert.rejects(
    rotateMcpOauthRefreshToken(params, () => ({
      access: { plaintext: "duplicate-access", hash: token.accessHash, prefix: "duplicate" },
      refresh: { plaintext: "new-refresh", hash: `${token.refreshHash}-new`, prefix: "new" },
    })),
  );

  const afterFailure = await db.query.mcpOauthTokens.findFirst({
    where: eq(schema.mcpOauthTokens.id, token.id),
  });
  assert.equal(afterFailure?.revokedAt, null);

  assert.ok(await rotateMcpOauthRefreshToken(params));
});
