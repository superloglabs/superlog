import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, db, runMigrations, schema } from "@superlog/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { DrizzleSentryAuthorizationRepository } from "./authorization-repository.js";
import { SentryAuthorizationError } from "./authorization-session.js";
import { mountSentryInstallationAuthed } from "./installation.js";

process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";
process.env.AGENT_SECRETS_KEY ||= randomBytes(32).toString("base64");

const orgIds: string[] = [];
const userIds: string[] = [];

before(async () => runMigrations());
after(async () => {
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

test("keeps a Sentry grant server-side until the user chooses one discovered project", async () => {
  const tag = `sentry-auth-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const [user] = await db
    .insert(schema.users)
    .values({ email: `${tag}@example.com` })
    .returning();
  assert.ok(user);
  userIds.push(user.id);
  const [org] = await db.insert(schema.orgs).values({ name: tag, slug: tag }).returning();
  assert.ok(org);
  orgIds.push(org.id);
  const [project] = await db
    .insert(schema.projects)
    .values({ orgId: org.id, name: "Default", slug: "default" })
    .returning();
  assert.ok(project);

  const repository = new DrizzleSentryAuthorizationRepository();
  const authorization = await repository.create({
    projectId: project.id,
    userId: user.id,
    organizationSlug: "acme",
    sentryInstallationId: "installation-1",
    projects: [
      { id: "1", slug: "storefront", name: "Storefront" },
      { id: "2", slug: "worker", name: "Worker" },
    ],
    token: {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: new Date("2026-07-23T00:00:00.000Z"),
    },
    expiresAt: new Date("2026-07-22T12:10:00.000Z"),
  });

  const visible = await repository.findReady({
    id: authorization.id,
    projectId: project.id,
    userId: user.id,
    now: new Date("2026-07-22T12:01:00.000Z"),
  });
  assert.deepEqual(visible, {
    id: authorization.id,
    organizationSlug: "acme",
    projects: [
      { id: "1", slug: "storefront", name: "Storefront" },
      { id: "2", slug: "worker", name: "Worker" },
    ],
    expiresAt: new Date("2026-07-22T12:10:00.000Z"),
  });

  await assert.rejects(
    repository.claim({
      id: authorization.id,
      projectId: project.id,
      userId: user.id,
      sentryProjectSlug: "not-returned-by-sentry",
      now: new Date("2026-07-22T12:01:30.000Z"),
    }),
    (error) => error instanceof SentryAuthorizationError && error.code === "invalid_selection",
  );

  const claim = await repository.claim({
    id: authorization.id,
    projectId: project.id,
    userId: user.id,
    sentryProjectSlug: "worker",
    now: new Date("2026-07-22T12:02:00.000Z"),
  });
  assert.deepEqual(claim, {
    organizationSlug: "acme",
    sentryInstallationId: "installation-1",
    project: { id: "2", slug: "worker", name: "Worker" },
    token: {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: new Date("2026-07-23T00:00:00.000Z"),
    },
  });
  assert.equal(
    await repository.findReady({
      id: authorization.id,
      projectId: project.id,
      userId: user.id,
      now: new Date("2026-07-22T12:03:00.000Z"),
    }),
    null,
  );
  const consumed = await db.query.sentryAuthorizationSessions.findFirst({
    where: eq(schema.sentryAuthorizationSessions.id, authorization.id),
  });
  assert.equal(consumed?.status, "consumed");
  assert.equal(consumed?.accessTokenCiphertext, null);
  assert.equal(consumed?.refreshTokenCiphertext, null);
});

test("clears encrypted grants from abandoned Sentry authorizations after their TTL", async () => {
  const tag = `sentry-expiry-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const [user] = await db
    .insert(schema.users)
    .values({ email: `${tag}@example.com` })
    .returning();
  assert.ok(user);
  userIds.push(user.id);
  const [org] = await db.insert(schema.orgs).values({ name: tag, slug: tag }).returning();
  assert.ok(org);
  orgIds.push(org.id);
  const [project] = await db
    .insert(schema.projects)
    .values({ orgId: org.id, name: "Default", slug: "default" })
    .returning();
  assert.ok(project);

  const repository = new DrizzleSentryAuthorizationRepository();
  const authorization = await repository.create({
    projectId: project.id,
    userId: user.id,
    organizationSlug: "acme",
    sentryInstallationId: "abandoned-installation",
    projects: [{ id: "1", slug: "storefront", name: "Storefront" }],
    token: {
      accessToken: "abandoned-access-token",
      refreshToken: "abandoned-refresh-token",
      expiresAt: new Date("2026-07-22T13:00:00.000Z"),
    },
    expiresAt: new Date("2026-07-22T12:10:00.000Z"),
  });

  assert.equal(await repository.expireReady(new Date("2026-07-22T12:11:00.000Z")), 1);
  const expired = await db.query.sentryAuthorizationSessions.findFirst({
    where: eq(schema.sentryAuthorizationSessions.id, authorization.id),
  });
  assert.equal(expired?.status, "failed");
  assert.equal(expired?.accessTokenCiphertext, null);
  assert.equal(expired?.refreshTokenCiphertext, null);
});

test("connects only the Sentry project claimed from the user-bound authorization", async () => {
  const tag = `sentry-connect-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const [user] = await db
    .insert(schema.users)
    .values({ email: `${tag}@example.com` })
    .returning();
  assert.ok(user);
  userIds.push(user.id);
  const [org] = await db.insert(schema.orgs).values({ name: tag, slug: tag }).returning();
  assert.ok(org);
  orgIds.push(org.id);
  await db.insert(schema.orgMembers).values({ orgId: org.id, userId: user.id, role: "owner" });
  const [project] = await db
    .insert(schema.projects)
    .values({ orgId: org.id, name: "Default", slug: "default" })
    .returning();
  assert.ok(project);

  const repository = new DrizzleSentryAuthorizationRepository();
  const authorization = await repository.create({
    projectId: project.id,
    userId: user.id,
    organizationSlug: "acme",
    sentryInstallationId: "installation-route-test",
    projects: [
      { id: "1", slug: "storefront", name: "Storefront" },
      { id: "2", slug: "worker", name: "Worker" },
    ],
    token: {
      accessToken: "route-access-token",
      refreshToken: "route-refresh-token",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });
  const imported: Array<{ projectSlug: string; targetProjectId: string }> = [];
  const app = new Hono<{ Variables: { userId: string; orgId: string | null } }>();
  app.use("/api/*", async (c, next) => {
    c.set("userId", user.id);
    c.set("orgId", org.id);
    await next();
  });
  mountSentryInstallationAuthed(app, {
    authorizations: repository,
    listProjects: async () => [],
    importOpenIssues: async (input) => {
      imported.push({ projectSlug: input.projectSlug, targetProjectId: input.targetProjectId });
      return 1;
    },
    getActiveCredential: async () => null,
  });

  const response = await app.request(
    `/api/projects/${project.id}/sentry/authorizations/${authorization.id}/connect`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectSlug: "worker" }),
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    installed: true,
    organizationSlug: "acme",
    projectSlug: "worker",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(imported, [{ projectSlug: "worker", targetProjectId: project.id }]);
  const installation = await db.query.sentryInstallations.findFirst({
    where: eq(schema.sentryInstallations.projectId, project.id),
  });
  assert.equal(installation?.sentryProjectSlug, "worker");
  assert.equal(installation?.organizationSlug, "acme");
});
