import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, db, runMigrations, schema } from "@superlog/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { mountProjectRouteContext } from "./project-route-context.js";

type Vars = { userId: string; sessionId?: string; orgId: string | null };

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

function uniq(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

async function seedContext(projectSlug = "demo-project") {
  const tag = uniq("route-context");
  const [user] = await db
    .insert(schema.users)
    .values({ email: `${tag}@example.com` })
    .returning();
  if (!user) throw new Error("seed user failed");
  userIds.push(user.id);

  const [org] = await db.insert(schema.orgs).values({ name: tag, slug: tag }).returning();
  if (!org) throw new Error("seed org failed");
  orgIds.push(org.id);
  await db.insert(schema.orgMembers).values({ orgId: org.id, userId: user.id, role: "member" });

  const [project] = await db
    .insert(schema.projects)
    .values({ orgId: org.id, name: "Demo project", slug: projectSlug })
    .returning();
  if (!project) throw new Error("seed project failed");

  const [session] = await db
    .insert(schema.sessions)
    .values({
      userId: user.id,
      token: uniq("session-token"),
      expiresAt: new Date(Date.now() + 60_000),
    })
    .returning();
  if (!session) throw new Error("seed session failed");
  return { user, org, project, session };
}

test("PUT /api/me/active-context selects an accessible org and project from route slugs", async () => {
  const { user, org, project, session } = await seedContext();
  const app = new Hono<{ Variables: Vars }>();
  app.use("*", (c, next) => {
    c.set("userId", user.id);
    c.set("sessionId", session.id);
    c.set("orgId", null);
    return next();
  });
  mountProjectRouteContext(app);

  const response = await app.request("/api/me/active-context", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ orgSlug: org.slug, projectSlug: project.slug }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    org: { id: org.id, name: org.name, slug: org.slug },
    project: { id: project.id, name: project.name, slug: project.slug },
  });
  const updatedSession = await db.query.sessions.findFirst({
    where: eq(schema.sessions.id, session.id),
  });
  const updatedUser = await db.query.users.findFirst({ where: eq(schema.users.id, user.id) });
  assert.equal(updatedSession?.activeOrganizationId, org.id);
  assert.equal(updatedUser?.activeOrgId, org.id);
  assert.equal(updatedUser?.activeProjectId, project.id);
});

test("PUT /api/me/active-context hides inaccessible route contexts without changing selection", async () => {
  const current = await seedContext();
  const inaccessible = await seedContext();
  await db
    .update(schema.sessions)
    .set({ activeOrganizationId: current.org.id })
    .where(eq(schema.sessions.id, current.session.id));
  await db
    .update(schema.users)
    .set({ activeOrgId: current.org.id, activeProjectId: current.project.id })
    .where(eq(schema.users.id, current.user.id));

  const app = new Hono<{ Variables: Vars }>();
  app.use("*", (c, next) => {
    c.set("userId", current.user.id);
    c.set("sessionId", current.session.id);
    c.set("orgId", null);
    return next();
  });
  mountProjectRouteContext(app);

  const response = await app.request("/api/me/active-context", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      orgSlug: inaccessible.org.slug,
      projectSlug: inaccessible.project.slug,
    }),
  });

  assert.equal(response.status, 404);
  const session = await db.query.sessions.findFirst({
    where: eq(schema.sessions.id, current.session.id),
  });
  const user = await db.query.users.findFirst({ where: eq(schema.users.id, current.user.id) });
  assert.equal(session?.activeOrganizationId, current.org.id);
  assert.equal(user?.activeOrgId, current.org.id);
  assert.equal(user?.activeProjectId, current.project.id);
});

test("PUT /api/me/active-context rejects an org and project slug from different memberships", async () => {
  const first = await seedContext();
  const second = await seedContext("other-project");
  await db
    .insert(schema.orgMembers)
    .values({ orgId: second.org.id, userId: first.user.id, role: "member" });

  const app = new Hono<{ Variables: Vars }>();
  app.use("*", (c, next) => {
    c.set("userId", first.user.id);
    c.set("sessionId", first.session.id);
    c.set("orgId", null);
    return next();
  });
  mountProjectRouteContext(app);

  const response = await app.request("/api/me/active-context", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ orgSlug: first.org.slug, projectSlug: second.project.slug }),
  });

  assert.equal(response.status, 404);
});

test("GET /api/me/org-route resolves a member org's route without touching the session", async () => {
  const current = await seedContext();
  const target = await seedContext("target-project");
  await db
    .insert(schema.orgMembers)
    .values({ orgId: target.org.id, userId: current.user.id, role: "member" });
  await db
    .update(schema.sessions)
    .set({ activeOrganizationId: current.org.id })
    .where(eq(schema.sessions.id, current.session.id));

  const app = new Hono<{ Variables: Vars }>();
  app.use("*", (c, next) => {
    c.set("userId", current.user.id);
    c.set("sessionId", current.session.id);
    c.set("orgId", current.org.id);
    return next();
  });
  mountProjectRouteContext(app);

  const response = await app.request(`/api/me/org-route?orgId=${target.org.id}`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    org: { id: target.org.id, name: target.org.name, slug: target.org.slug },
    defaultProjectSlug: target.project.slug,
    projects: [{ id: target.project.id, name: target.project.name, slug: target.project.slug }],
  });
  // Read-only: the session's active org is untouched, so ProjectRouteBoundary
  // (not this endpoint) drives the switch once the URL leads.
  const session = await db.query.sessions.findFirst({
    where: eq(schema.sessions.id, current.session.id),
  });
  assert.equal(session?.activeOrganizationId, current.org.id);
});

test("GET /api/me/org-route lists a multi-project org's projects in stable creation order", async () => {
  const current = await seedContext();
  const target = await seedContext("first-project");
  await db
    .insert(schema.orgMembers)
    .values({ orgId: target.org.id, userId: current.user.id, role: "member" });
  // Add a second, later project so the picker has more than one to show.
  const [second] = await db
    .insert(schema.projects)
    .values({ orgId: target.org.id, name: "Second project", slug: "second-project" })
    .returning();
  if (!second) throw new Error("seed second project failed");

  const app = new Hono<{ Variables: Vars }>();
  app.use("*", (c, next) => {
    c.set("userId", current.user.id);
    c.set("sessionId", current.session.id);
    c.set("orgId", current.org.id);
    return next();
  });
  mountProjectRouteContext(app);

  const response = await app.request(`/api/me/org-route?orgId=${target.org.id}`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    projects: { slug: string }[];
    defaultProjectSlug: string;
  };
  assert.deepEqual(
    body.projects.map((p) => p.slug),
    ["first-project", "second-project"],
  );
});

test("GET /api/me/org-route hides orgs the user isn't a member of", async () => {
  const current = await seedContext();
  const foreign = await seedContext("foreign-project");

  const app = new Hono<{ Variables: Vars }>();
  app.use("*", (c, next) => {
    c.set("userId", current.user.id);
    c.set("sessionId", current.session.id);
    c.set("orgId", current.org.id);
    return next();
  });
  mountProjectRouteContext(app);

  const response = await app.request(`/api/me/org-route?orgId=${foreign.org.id}`);

  // Must not fall back to the caller's own org — a non-member org is a 404.
  assert.equal(response.status, 404);
});

test("GET /api/me/org-route requires an orgId", async () => {
  const current = await seedContext();

  const app = new Hono<{ Variables: Vars }>();
  app.use("*", (c, next) => {
    c.set("userId", current.user.id);
    c.set("sessionId", current.session.id);
    c.set("orgId", current.org.id);
    return next();
  });
  mountProjectRouteContext(app);

  const response = await app.request("/api/me/org-route");
  assert.equal(response.status, 400);
});
