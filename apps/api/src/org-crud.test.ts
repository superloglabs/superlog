import "dotenv/config";
import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import { closeDb, db, runMigrations, schema } from "@superlog/db";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { mountOrgCrud } from "./orgs.js";

type Vars = { userId: string; orgId: string | null };

const orgIds: string[] = [];
const userIds: string[] = [];

before(async () => {
  await runMigrations();
});
after(async () => {
  try {
    // Orgs first (cascades members/projects), then the users we seeded.
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

function uniq(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

async function seedUser() {
  const tag = uniq("ocrud-user");
  const [user] = await db
    .insert(schema.users)
    .values({ email: `${tag}@example.com` })
    .returning();
  if (!user) throw new Error("seed user failed");
  userIds.push(user.id);
  return user;
}

async function seedOrgWithMember(userId: string, role: "owner" | "admin" | "member" = "owner") {
  const tag = uniq("ocrud-org");
  const [org] = await db.insert(schema.orgs).values({ name: tag, slug: tag }).returning();
  if (!org) throw new Error("seed org failed");
  orgIds.push(org.id);
  await db.insert(schema.orgMembers).values({ orgId: org.id, userId, role });
  return org;
}

function appFor(userId: string, orgId: string | null) {
  const app = new Hono<{ Variables: Vars }>();
  app.use("*", (c, next) => {
    c.set("userId", userId);
    c.set("orgId", orgId);
    return next();
  });
  mountOrgCrud(app);
  return app;
}

test("POST /api/orgs creates a new owner org with a Default project", async () => {
  const user = await seedUser();
  const app = appFor(user.id, null);

  const res = await app.request("/api/orgs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Acme Two" }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    org: { id: string; name: string; slug: string };
    project: { id: string; name: string; slug: string };
  };
  orgIds.push(body.org.id); // ensure teardown removes the endpoint-created org

  assert.equal(body.org.name, "Acme Two");
  assert.ok(body.org.slug.length > 0);

  const member = await db.query.orgMembers.findFirst({
    where: and(eq(schema.orgMembers.orgId, body.org.id), eq(schema.orgMembers.userId, user.id)),
  });
  assert.equal(member?.role, "owner");

  const project = await db.query.projects.findFirst({
    where: eq(schema.projects.id, body.project.id),
  });
  assert.equal(project?.orgId, body.org.id);
  assert.equal(project?.slug, "default");

  const settings = await db.query.projectAutomationSettings.findFirst({
    where: eq(schema.projectAutomationSettings.projectId, body.project.id),
  });
  assert.ok(settings, "default project should have automation settings");
});

test("POST /api/orgs rejects an empty name", async () => {
  const user = await seedUser();
  const app = appFor(user.id, null);
  const res = await app.request("/api/orgs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "   " }),
  });
  assert.equal(res.status, 400);
});

test("DELETE /api/orgs/:id as owner removes the org and cascades its projects", async () => {
  const user = await seedUser();
  const keepOrg = await seedOrgWithMember(user.id, "owner");
  const delOrg = await seedOrgWithMember(user.id, "owner");
  const [proj] = await db
    .insert(schema.projects)
    .values({ orgId: delOrg.id, name: "Doomed", slug: uniq("doomed") })
    .returning();
  assert.ok(proj);

  const app = appFor(user.id, delOrg.id);
  const res = await app.request(`/api/orgs/${delOrg.id}`, { method: "DELETE" });
  assert.equal(res.status, 200);

  assert.equal(await db.query.orgs.findFirst({ where: eq(schema.orgs.id, delOrg.id) }), undefined);
  assert.equal(
    await db.query.projects.findFirst({ where: eq(schema.projects.id, proj.id) }),
    undefined,
    "project should be cascade-deleted with the org",
  );
  assert.ok(
    await db.query.orgs.findFirst({ where: eq(schema.orgs.id, keepOrg.id) }),
    "the caller's other org must be untouched",
  );
});

test("DELETE /api/orgs/:id as a non-owner member is forbidden (403)", async () => {
  const user = await seedUser();
  await seedOrgWithMember(user.id, "owner"); // a second org so the last-org guard doesn't mask the 403
  const org = await seedOrgWithMember(user.id, "member");

  const app = appFor(user.id, org.id);
  const res = await app.request(`/api/orgs/${org.id}`, { method: "DELETE" });
  assert.equal(res.status, 403);
  assert.ok(await db.query.orgs.findFirst({ where: eq(schema.orgs.id, org.id) }));
});

test("DELETE /api/orgs/:id of an org the caller doesn't belong to is 404", async () => {
  const owner = await seedUser();
  const org = await seedOrgWithMember(owner.id, "owner");
  const stranger = await seedUser();
  await seedOrgWithMember(stranger.id, "owner");

  const app = appFor(stranger.id, null);
  const res = await app.request(`/api/orgs/${org.id}`, { method: "DELETE" });
  assert.equal(res.status, 404);
  assert.ok(await db.query.orgs.findFirst({ where: eq(schema.orgs.id, org.id) }));
});

test("DELETE /api/orgs/:id of the caller's only org is blocked (409)", async () => {
  const user = await seedUser();
  const org = await seedOrgWithMember(user.id, "owner");

  const app = appFor(user.id, org.id);
  const res = await app.request(`/api/orgs/${org.id}`, { method: "DELETE" });
  assert.equal(res.status, 409);
  assert.ok(await db.query.orgs.findFirst({ where: eq(schema.orgs.id, org.id) }));
});
