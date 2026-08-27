import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, db, runMigrations, schema } from "@superlog/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { buildSupabaseOAuthOutcomeUrl, mountSupabaseAuthed } from "./interfaces.js";

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

test("a project member can read Supabase integration state without managing it", async () => {
  const tag = `supabase-member-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const [org] = await db.insert(schema.orgs).values({ name: tag, slug: tag }).returning();
  const [user] = await db
    .insert(schema.users)
    .values({ email: `${tag}@example.com` })
    .returning();
  assert.ok(org);
  assert.ok(user);
  orgIds.push(org.id);
  userIds.push(user.id);
  await db.insert(schema.orgMembers).values({ orgId: org.id, userId: user.id, role: "member" });
  const [project] = await db
    .insert(schema.projects)
    .values({ orgId: org.id, name: "Supabase", slug: `supabase-${crypto.randomUUID()}` })
    .returning();
  assert.ok(project);

  const app = new Hono<{ Variables: { userId: string; orgId: string | null } }>();
  app.use("/api/*", async (c, next) => {
    c.set("userId", user.id);
    c.set("orgId", org.id);
    await next();
  });
  mountSupabaseAuthed(app);

  const response = await app.request(`/api/projects/${project.id}/supabase`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    configured: false,
    canManage: false,
    grants: [],
    connections: [],
  });
});

test("the OAuth callback returns to the Superlog project that initiated it", () => {
  const url = new URL(
    buildSupabaseOAuthOutcomeUrl({
      webOrigin: "https://app.example.com",
      status: "connected",
      grantId: "grant-1",
      projectId: "project-2",
    }),
  );

  assert.equal(url.pathname, "/app/settings");
  assert.equal(url.searchParams.get("projectId"), "project-2");
  assert.equal(url.searchParams.get("supabase_grant"), "grant-1");
});
