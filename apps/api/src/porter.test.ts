import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, db, runMigrations, schema } from "@superlog/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { mountPorterAuthed } from "./porter.js";

type Vars = { userId: string; orgId: string | null };

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

async function appFor(role: "owner" | "member") {
  const tag = `porter-${role}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const [org] = await db.insert(schema.orgs).values({ name: tag, slug: tag }).returning();
  if (!org) throw new Error("failed to seed org");
  orgIds.push(org.id);

  const [user] = await db
    .insert(schema.users)
    .values({ email: `${tag}@example.com` })
    .returning();
  if (!user) throw new Error("failed to seed user");
  userIds.push(user.id);
  await db.insert(schema.orgMembers).values({ orgId: org.id, userId: user.id, role });

  const [project] = await db
    .insert(schema.projects)
    .values({ orgId: org.id, name: "Porter", slug: tag })
    .returning();
  if (!project) throw new Error("failed to seed project");

  const app = new Hono<{ Variables: Vars }>();
  app.use("*", (c, next) => {
    c.set("userId", user.id);
    c.set("orgId", org.id);
    return next();
  });
  mountPorterAuthed(app);
  return { app, project };
}

test("a project owner receives a ready-to-paste Porter setup with a fresh ingest key", async () => {
  const { app, project } = await appFor("owner");

  const response = await app.request(`/api/projects/${project.id}/integrations/porter/setup`, {
    method: "POST",
  });

  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    dashboardUrl: string;
    addonName: string;
    chart: { repositoryUrl: string; name: string; version: string };
    key: { id: string; prefix: string; plaintext: string };
    valuesYaml: string;
  };
  assert.deepEqual(
    {
      dashboardUrl: body.dashboardUrl,
      addonName: body.addonName,
      chart: body.chart,
    },
    {
      dashboardUrl: "https://dashboard.porter.run",
      addonName: "superlog-otel",
      chart: {
        repositoryUrl: "https://superloglabs.github.io/helm-charts",
        name: "superlog-otel",
        version: "0.1.1",
      },
    },
  );
  assert.match(body.key.plaintext, /^sl_public_/);
  assert.match(body.key.prefix, /^sl_public_/);
  assert.equal(body.valuesYaml, `global:\n  superlog:\n    apiKey: ${body.key.plaintext}\n`);

  const persisted = await db.query.apiKeys.findFirst({
    where: eq(schema.apiKeys.id, body.key.id),
  });
  assert.equal(persisted?.projectId, project.id);
  assert.equal(persisted?.name, "Porter Helm install");
});

test("regenerating Porter setup issues a different key without revoking the previous install", async () => {
  const { app, project } = await appFor("owner");

  const firstResponse = await app.request(`/api/projects/${project.id}/integrations/porter/setup`, {
    method: "POST",
  });
  const secondResponse = await app.request(
    `/api/projects/${project.id}/integrations/porter/setup`,
    { method: "POST" },
  );
  const first = (await firstResponse.json()) as { key: { id: string; plaintext: string } };
  const second = (await secondResponse.json()) as { key: { id: string; plaintext: string } };

  assert.notEqual(second.key.id, first.key.id);
  assert.notEqual(second.key.plaintext, first.key.plaintext);
  const keys = await db.query.apiKeys.findMany({
    where: eq(schema.apiKeys.projectId, project.id),
  });
  assert.equal(keys.length, 2);
  assert.equal(
    keys.every((key) => key.revokedAt === null),
    true,
    "opening setup must not break an existing Porter collector",
  );
});

test("an ordinary project member cannot mint a Porter ingest key", async () => {
  const { app, project } = await appFor("member");

  const response = await app.request(`/api/projects/${project.id}/integrations/porter/setup`, {
    method: "POST",
  });

  assert.equal(response.status, 403);
  const keys = await db.query.apiKeys.findMany({
    where: eq(schema.apiKeys.projectId, project.id),
  });
  assert.equal(keys.length, 0);
});
