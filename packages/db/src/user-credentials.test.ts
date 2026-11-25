import assert from "node:assert/strict";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { DB } from "./client.js";
import * as schema from "./schema.js";
import { isBanActive, revokeUserCredentials, userHasActiveBan } from "./user-credentials.js";

// The resolvers below default to the shared client, which needs a connection
// string at import time; postgres-js connects lazily, so a dummy is enough.
process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";
const { generateOrgManagementKey, generatePersonalAccessToken } = await import("./keys.js");
const { resolvePersonalAccessToken } = await import("./personal-access-tokens.js");
const { resolveOrgApiKey } = await import("./org-api-keys.js");

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");
const NOW = new Date("2026-07-15T10:00:00.000Z");
const LATER = new Date("2026-08-15T10:00:00.000Z");

// One migrated database for the file; each test seeds its own users.
let client: PGlite;
let db: DB;

before(async () => {
  client = new PGlite();
  db = drizzle(client, { schema }) as unknown as DB;
  await migrate(db as never, { migrationsFolder: MIGRATIONS });
});

after(async () => {
  // resolveOrgApiKey stamps last_used_at without awaiting it. PGlite runs
  // queries in order, so one awaited query lets that write finish first.
  await client.query("select 1");
  await client.close();
});

type Seeded = {
  userId: string;
  sessionTokens: string[];
  apiKeyId: string;
};

// Gives a user one of every credential type: two browser sessions, a CLI
// session, a personal access token, an MCP OAuth grant, a used and an unused
// MCP authorization code, an org management key, plus a project ingest key.
async function seedUserWithCredentials(db: DB, label: string): Promise<Seeded> {
  const tag = `${label}-${crypto.randomUUID()}`;
  const [user] = await db
    .insert(schema.users)
    .values({ email: `${tag}@example.com` })
    .returning();
  assert.ok(user);
  const [org] = await db.insert(schema.orgs).values({ name: tag, slug: tag }).returning();
  assert.ok(org);
  const [project] = await db
    .insert(schema.projects)
    .values({ orgId: org.id, name: "Default", slug: "default" })
    .returning();
  assert.ok(project);
  await db.insert(schema.orgMembers).values({ orgId: org.id, userId: user.id, role: "owner" });

  const sessionTokens = [`${tag}-session-a`, `${tag}-session-b`];
  await db.insert(schema.sessions).values(
    sessionTokens.map((token) => ({
      userId: user.id,
      token,
      expiresAt: LATER,
    })),
  );
  await db.insert(schema.cliSessions).values({
    userId: user.id,
    orgId: org.id,
    tokenPrefix: "superlog_cli_x",
    tokenHash: `${tag}-cli`,
    expiresAt: LATER,
  });
  await db.insert(schema.personalAccessTokens).values({
    userId: user.id,
    projectId: project.id,
    name: "laptop",
    tokenPrefix: "superlog_pat_x",
    tokenHash: `${tag}-pat`,
  });
  const [client] = await db
    .insert(schema.mcpOauthClients)
    .values({ name: "Agent", redirectUris: ["http://127.0.0.1/callback"] })
    .returning();
  assert.ok(client);
  await db.insert(schema.mcpOauthTokens).values({
    accessHash: `${tag}-access`,
    refreshHash: `${tag}-refresh`,
    clientId: client.id,
    userId: user.id,
    projectId: project.id,
    resource: "https://api.example.com/mcp",
    accessExpiresAt: LATER,
    refreshExpiresAt: LATER,
  });
  const code = {
    clientId: client.id,
    userId: user.id,
    projectId: project.id,
    redirectUri: "http://127.0.0.1/callback",
    codeChallenge: "challenge",
    codeChallengeMethod: "S256",
    resource: "https://api.example.com/mcp",
    expiresAt: LATER,
  };
  await db.insert(schema.mcpOauthCodes).values([
    { ...code, code: `${tag}-code-unused` },
    { ...code, code: `${tag}-code-used`, usedAt: NOW },
  ]);
  await db.insert(schema.orgApiKeys).values({
    orgId: org.id,
    name: "backend",
    keyPrefix: "sl_management_x",
    keyHash: `${tag}-mgmt`,
    createdByUserId: user.id,
  });
  const [apiKey] = await db
    .insert(schema.apiKeys)
    .values({
      projectId: project.id,
      name: "ingest",
      keyPrefix: "sl_public_x",
      keyHash: `${tag}-ingest`,
    })
    .returning();
  assert.ok(apiKey);
  return { userId: user.id, sessionTokens, apiKeyId: apiKey.id };
}

async function liveCredentials(db: DB, userId: string) {
  const sessions = await db.query.sessions.findMany({ where: eq(schema.sessions.userId, userId) });
  const cli = await db.query.cliSessions.findMany({ where: eq(schema.cliSessions.userId, userId) });
  const pats = await db.query.personalAccessTokens.findMany({
    where: eq(schema.personalAccessTokens.userId, userId),
  });
  const mcpTokens = await db.query.mcpOauthTokens.findMany({
    where: eq(schema.mcpOauthTokens.userId, userId),
  });
  const mcpCodes = await db.query.mcpOauthCodes.findMany({
    where: eq(schema.mcpOauthCodes.userId, userId),
  });
  const orgKeys = await db.query.orgApiKeys.findMany({
    where: eq(schema.orgApiKeys.createdByUserId, userId),
  });
  return {
    sessionTokens: sessions.map((s) => s.token).sort(),
    cliSessions: cli.filter((r) => !r.revokedAt).length,
    personalAccessTokens: pats.filter((r) => !r.revokedAt).length,
    mcpOauthTokens: mcpTokens.filter((r) => !r.revokedAt).length,
    unusedMcpOauthCodes: mcpCodes.filter((r) => !r.usedAt).length,
    orgApiKeys: orgKeys.filter((r) => !r.revokedAt).length,
  };
}

test("revoking a user's credentials ends every session and bearer credential they hold", async () => {
  const target = await seedUserWithCredentials(db, "target");
  const bystander = await seedUserWithCredentials(db, "bystander");

  const revoked = await revokeUserCredentials(db, target.userId, { now: NOW });

  assert.deepEqual(revoked, {
    sessions: 2,
    cliSessions: 1,
    personalAccessTokens: 1,
    mcpOauthTokens: 1,
    mcpOauthCodes: 1,
    orgApiKeys: 1,
  });
  assert.deepEqual(await liveCredentials(db, target.userId), {
    sessionTokens: [],
    cliSessions: 0,
    personalAccessTokens: 0,
    mcpOauthTokens: 0,
    unusedMcpOauthCodes: 0,
    orgApiKeys: 0,
  });
  // Another user's credentials are untouched.
  assert.deepEqual(await liveCredentials(db, bystander.userId), {
    sessionTokens: [...bystander.sessionTokens].sort(),
    cliSessions: 1,
    personalAccessTokens: 1,
    mcpOauthTokens: 1,
    unusedMcpOauthCodes: 1,
    orgApiKeys: 1,
  });
  // Project ingest keys are held by the project, not the person.
  const apiKey = await db.query.apiKeys.findFirst({
    where: eq(schema.apiKeys.id, target.apiKeyId),
  });
  assert.equal(apiKey?.revokedAt, null);
});

test("revoking credentials can keep the session that made the change", async () => {
  const target = await seedUserWithCredentials(db, "target");
  const [current, other] = target.sessionTokens as [string, string];

  const revoked = await revokeUserCredentials(db, target.userId, {
    keepSessionToken: current,
    now: NOW,
  });

  assert.equal(revoked.sessions, 1);
  const live = await liveCredentials(db, target.userId);
  assert.deepEqual(live.sessionTokens, [current]);
  assert.ok(!live.sessionTokens.includes(other));
  assert.equal(live.personalAccessTokens, 0);
});

test("revoking credentials again is a no-op", async () => {
  const target = await seedUserWithCredentials(db, "target");
  await revokeUserCredentials(db, target.userId, { now: NOW });
  const second = await revokeUserCredentials(db, target.userId, { now: LATER });
  assert.deepEqual(second, {
    sessions: 0,
    cliSessions: 0,
    personalAccessTokens: 0,
    mcpOauthTokens: 0,
    mcpOauthCodes: 0,
    orgApiKeys: 0,
  });
  // The first revocation time is kept.
  const pat = await db.query.personalAccessTokens.findFirst({
    where: eq(schema.personalAccessTokens.userId, target.userId),
  });
  assert.equal(pat?.revokedAt?.toISOString(), NOW.toISOString());
});

test("a ban is active while banned and not past its expiry", () => {
  assert.equal(isBanActive({ banned: false, banExpires: null }, NOW), false);
  assert.equal(isBanActive({ banned: null, banExpires: null }, NOW), false);
  assert.equal(isBanActive({ banned: true, banExpires: null }, NOW), true);
  assert.equal(isBanActive({ banned: true, banExpires: LATER }, NOW), true);
  assert.equal(isBanActive({ banned: true, banExpires: LATER.toISOString() }, NOW), true);
  assert.equal(isBanActive({ banned: true, banExpires: new Date(NOW.getTime() - 1) }, NOW), false);
});

test("userHasActiveBan reads the user's current ban state", async () => {
  const [user] = await db
    .insert(schema.users)
    .values({ email: `ban-${crypto.randomUUID()}@example.com` })
    .returning();
  assert.ok(user);
  assert.equal(await userHasActiveBan(db, user.id, NOW), false);

  await db.update(schema.users).set({ banned: true }).where(eq(schema.users.id, user.id));
  assert.equal(await userHasActiveBan(db, user.id, NOW), true);

  await db
    .update(schema.users)
    .set({ banExpires: new Date(NOW.getTime() - 1000) })
    .where(eq(schema.users.id, user.id));
  assert.equal(await userHasActiveBan(db, user.id, NOW), false);

  assert.equal(await userHasActiveBan(db, crypto.randomUUID(), NOW), false);
});

async function seedUserInProject(label: string) {
  const tag = `${label}-${crypto.randomUUID()}`;
  const [user] = await db
    .insert(schema.users)
    .values({ email: `${tag}@example.com` })
    .returning();
  assert.ok(user);
  const [org] = await db.insert(schema.orgs).values({ name: tag, slug: tag }).returning();
  assert.ok(org);
  const [project] = await db
    .insert(schema.projects)
    .values({ orgId: org.id, name: "Default", slug: "default" })
    .returning();
  assert.ok(project);
  return { user, org, project };
}

async function ban(userId: string, banExpires: Date | null = null) {
  await db
    .update(schema.users)
    .set({ banned: true, banExpires })
    .where(eq(schema.users.id, userId));
}

test("a personal access token stops resolving while its owner is banned", async () => {
  const { user, project } = await seedUserInProject("pat-owner");
  const token = generatePersonalAccessToken();
  await db.insert(schema.personalAccessTokens).values({
    userId: user.id,
    projectId: project.id,
    name: "laptop",
    tokenPrefix: token.prefix,
    tokenHash: token.hash,
  });

  const before = await resolvePersonalAccessToken(token.plaintext, db);
  assert.ok(!("reason" in before));

  await ban(user.id, new Date(Date.now() + 60_000));
  assert.deepEqual(await resolvePersonalAccessToken(token.plaintext, db), {
    reason: "user banned",
  });

  await ban(user.id, new Date(Date.now() - 60_000));
  const afterExpiry = await resolvePersonalAccessToken(token.plaintext, db);
  assert.ok(!("reason" in afterExpiry));
});

test("an org management key stops resolving while the user who created it is banned", async () => {
  const { user, org } = await seedUserInProject("key-creator");
  const key = generateOrgManagementKey();
  const [row] = await db
    .insert(schema.orgApiKeys)
    .values({
      orgId: org.id,
      name: "backend",
      keyPrefix: key.prefix,
      keyHash: key.hash,
      createdByUserId: user.id,
    })
    .returning();
  assert.ok(row);

  assert.deepEqual(await resolveOrgApiKey(key.plaintext, db), { id: row.id, orgId: org.id });

  await ban(user.id);
  assert.equal(await resolveOrgApiKey(key.plaintext, db), null);
});

test("an org management key with no recorded creator still resolves", async () => {
  const { org } = await seedUserInProject("key-orphan");
  const key = generateOrgManagementKey();
  const [row] = await db
    .insert(schema.orgApiKeys)
    .values({ orgId: org.id, name: "backend", keyPrefix: key.prefix, keyHash: key.hash })
    .returning();
  assert.ok(row);
  assert.deepEqual(await resolveOrgApiKey(key.plaintext, db), { id: row.id, orgId: org.id });
});
