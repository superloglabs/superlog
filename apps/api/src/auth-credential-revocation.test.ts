import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, db, generatePersonalAccessToken, runMigrations, schema } from "@superlog/db";
import { eq } from "drizzle-orm";

// A password reset, password change, or ban ends the user's sessions and
// revokes the bearer credentials they hold. These tests drive the real Better
// Auth instance against Postgres so they cover the wiring in auth.ts, not just
// the revocation itself.

process.env.BETTER_AUTH_SECRET ??= "test-better-auth-secret";
const { auth } = await import("./auth.js");

const PASSWORD = "correct-horse-battery";
const NEW_PASSWORD = "new-correct-horse-battery";

const orgIds: string[] = [];
const userIds: string[] = [];

before(async () => {
  await runMigrations();
});

after(async () => {
  try {
    for (const orgId of orgIds) await db.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
    for (const userId of userIds) await db.delete(schema.users).where(eq(schema.users.id, userId));
  } finally {
    await closeDb();
  }
});

async function seedUser(label: string, role = "user") {
  const tag = `${label}-${randomUUID()}`;
  const email = `${tag}@example.com`;
  const [user] = await db.insert(schema.users).values({ email, role }).returning();
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

  const ctx = await auth.$context;
  await ctx.internalAdapter.createAccount({
    userId: user.id,
    providerId: "credential",
    accountId: user.id,
    password: await ctx.password.hash(PASSWORD),
  });

  const pat = generatePersonalAccessToken();
  await db.insert(schema.personalAccessTokens).values({
    userId: user.id,
    projectId: project.id,
    name: "laptop",
    tokenPrefix: pat.prefix,
    tokenHash: pat.hash,
  });
  return { id: user.id, email };
}

// Signs in and returns the session token plus the cookie header that carries it.
async function signIn(email: string, password = PASSWORD) {
  const { headers, response } = await auth.api.signInEmail({
    body: { email, password },
    returnHeaders: true,
  });
  const cookie = headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return { token: response.token, headers: new Headers({ cookie }) };
}

async function sessionTokens(userId: string): Promise<string[]> {
  const rows = await db.query.sessions.findMany({ where: eq(schema.sessions.userId, userId) });
  return rows.map((r) => r.token).sort();
}

async function patRevoked(userId: string): Promise<boolean> {
  const pat = await db.query.personalAccessTokens.findFirst({
    where: eq(schema.personalAccessTokens.userId, userId),
  });
  return Boolean(pat?.revokedAt);
}

test("a password reset ends every session and revokes the user's tokens", async () => {
  const user = await seedUser("reset");
  await signIn(user.email);
  await signIn(user.email);
  assert.equal((await sessionTokens(user.id)).length, 2);

  const ctx = await auth.$context;
  const resetToken = randomUUID();
  await ctx.internalAdapter.createVerificationValue({
    identifier: `reset-password:${resetToken}`,
    value: user.id,
    expiresAt: new Date(Date.now() + 60_000),
  });
  await auth.api.resetPassword({ body: { token: resetToken, newPassword: NEW_PASSWORD } });

  assert.deepEqual(await sessionTokens(user.id), []);
  assert.equal(await patRevoked(user.id), true);
});

test("a password change keeps only the session that made it", async () => {
  const user = await seedUser("change");
  const current = await signIn(user.email);
  await signIn(user.email);

  await auth.api.changePassword({
    body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    headers: current.headers,
  });

  assert.deepEqual(await sessionTokens(user.id), [current.token]);
  assert.equal(await patRevoked(user.id), true);
});

test("a password change that rotates the session keeps only the new session", async () => {
  const user = await seedUser("change-rotate");
  const current = await signIn(user.email);
  await signIn(user.email);

  const result = await auth.api.changePassword({
    body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, revokeOtherSessions: true },
    headers: current.headers,
  });

  assert.ok(result.token);
  assert.deepEqual(await sessionTokens(user.id), [result.token]);
  assert.equal(await patRevoked(user.id), true);
});

test("a rejected password change revokes nothing", async () => {
  const user = await seedUser("change-rejected");
  const current = await signIn(user.email);
  const other = await signIn(user.email);

  await assert.rejects(
    auth.api.changePassword({
      body: { currentPassword: "wrong-password-here", newPassword: NEW_PASSWORD },
      headers: current.headers,
    }),
  );

  assert.deepEqual(await sessionTokens(user.id), [current.token, other.token].sort());
  assert.equal(await patRevoked(user.id), false);
});

test("an admin setting a user's password ends that user's sessions and tokens", async () => {
  const admin = await seedUser("admin-set", "admin");
  const adminSession = await signIn(admin.email);
  const user = await seedUser("target-set");
  await signIn(user.email);

  await auth.api.setUserPassword({
    body: { userId: user.id, newPassword: NEW_PASSWORD },
    headers: adminSession.headers,
  });

  assert.deepEqual(await sessionTokens(user.id), []);
  assert.equal(await patRevoked(user.id), true);
  // The admin's own session and tokens are untouched.
  assert.deepEqual(await sessionTokens(admin.id), [adminSession.token]);
  assert.equal(await patRevoked(admin.id), false);
});

test("banning a user ends their sessions and revokes their tokens", async () => {
  const admin = await seedUser("admin-ban", "admin");
  const adminSession = await signIn(admin.email);
  const user = await seedUser("target-ban");
  await signIn(user.email);

  await auth.api.banUser({ body: { userId: user.id }, headers: adminSession.headers });

  assert.deepEqual(await sessionTokens(user.id), []);
  assert.equal(await patRevoked(user.id), true);
  assert.equal(await patRevoked(admin.id), false);
});

test("banning a user through an admin profile update revokes their tokens", async () => {
  const admin = await seedUser("admin-update", "admin");
  const adminSession = await signIn(admin.email);
  const user = await seedUser("target-update");

  await auth.api.adminUpdateUser({
    body: { userId: user.id, data: { banned: true } },
    headers: adminSession.headers,
  });

  assert.equal(await patRevoked(user.id), true);
});

test("an admin profile update that does not ban revokes nothing", async () => {
  const admin = await seedUser("admin-rename", "admin");
  const adminSession = await signIn(admin.email);
  const user = await seedUser("target-rename");
  const userSession = await signIn(user.email);

  await auth.api.adminUpdateUser({
    body: { userId: user.id, data: { name: "Renamed" } },
    headers: adminSession.headers,
  });

  assert.deepEqual(await sessionTokens(user.id), [userSession.token]);
  assert.equal(await patRevoked(user.id), false);
});
