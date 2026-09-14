import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { closeDb, db, runMigrations, schema } from "@superlog/db";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { mountOauthEndpoints } from "./oauth.js";

const resource = "https://api.example.com/mcp";
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

async function seedAuthorizationCode() {
  const tag = `mcp-code-${randomUUID()}`;
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

  return { clientId: client.id, code };
}

async function waitForBlockedCodeRedemptions(): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const [row] = await db.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND state = 'active'
        AND wait_event_type = 'Lock'
        AND position('mcp_oauth_codes' in query) > 0
    `);
    if ((row?.count ?? 0) >= 2) return;
    await delay(10);
  }
  throw new Error("concurrent code redemptions did not reach the database claim");
}

test("only one concurrent request can redeem an authorization code", async () => {
  const { clientId, code } = await seedAuthorizationCode();
  const app = new Hono();
  mountOauthEndpoints(app, {
    apiBaseUrl: "https://api.example.com",
    webOrigin: "https://app.example.com",
    resource,
  });
  const fields = {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
    client_id: clientId,
    resource,
  };

  // Keep both handlers between their initial read and claim. This makes the
  // read-then-update race deterministic instead of relying on request timing.
  let releaseCodeLock!: () => void;
  const codeLockReleased = new Promise<void>((resolve) => {
    releaseCodeLock = resolve;
  });
  let signalCodeLocked!: () => void;
  let signalCodeLockFailed!: (error: unknown) => void;
  const codeLocked = new Promise<void>((resolve, reject) => {
    signalCodeLocked = resolve;
    signalCodeLockFailed = reject;
  });
  const codeLock = db
    .transaction(async (tx) => {
      await tx.execute(sql`
        SELECT code FROM mcp_oauth_codes WHERE code = ${code} FOR UPDATE
      `);
      signalCodeLocked();
      await codeLockReleased;
    })
    .catch((error) => {
      signalCodeLockFailed(error);
      throw error;
    });
  await codeLocked;

  const pendingResponses = Promise.all([
    app.request("/oauth/token", { method: "POST", body: new URLSearchParams(fields) }),
    app.request("/oauth/token", { method: "POST", body: new URLSearchParams(fields) }),
  ]);
  try {
    await waitForBlockedCodeRedemptions();
  } finally {
    releaseCodeLock();
    await codeLock;
  }

  const responses = await pendingResponses;
  const statuses = responses.map((response) => response.status).sort();

  assert.deepEqual(statuses, [200, 400]);
  const rejected = responses.find((response) => response.status === 400);
  assert.deepEqual(await rejected?.json(), {
    error: "invalid_grant",
    error_description: "code already used",
  });
});
