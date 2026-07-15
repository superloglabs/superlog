import "dotenv/config";
import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import { closeDb, db, runMigrations, schema } from "@superlog/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { IngestFilterState } from "./ingest-filters-service.js";
import { mountIngestFilters } from "./ingest-filters.js";

type Vars = { userId: string; orgId: string | null };
const orgIds: string[] = [];

before(async () => {
  await runMigrations();
});
after(async () => {
  try {
    for (const orgId of orgIds.reverse()) {
      await db.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
    }
  } finally {
    await closeDb();
  }
});

async function seedProject(role: "owner" | "admin" | "member" = "owner") {
  const tag = `if-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const [org] = await db.insert(schema.orgs).values({ name: tag, slug: tag }).returning();
  if (!org) throw new Error("seed org failed");
  orgIds.push(org.id);
  const [user] = await db
    .insert(schema.users)
    .values({ email: `${tag}@example.com` })
    .returning();
  if (!user) throw new Error("seed user failed");
  await db.insert(schema.orgMembers).values({ orgId: org.id, userId: user.id, role });
  const [project] = await db
    .insert(schema.projects)
    .values({ orgId: org.id, name: "test", slug: tag })
    .returning();
  if (!project) throw new Error("seed project failed");
  return { org, user, project };
}

test("an ordinary member cannot disable telemetry ingestion", async () => {
  const { org, user, project } = await seedProject("member");
  const app = appFor(user.id, org.id);

  const res = await app.request(`/api/projects/${project.id}/ingest-filters`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      otlp: { traces: false, logs: false, metrics: false },
      aws: { logs: false, metrics: false },
      gcp: { logs: false, metrics: false },
      vercel: { traces: false, logs: false },
      railway: { logs: false, metrics: false },
      render: { logs: false, metrics: false },
    }),
  });

  assert.equal(res.status, 403);
  assert.equal(
    (
      await db.query.projectIngestFilters.findMany({
        where: eq(schema.projectIngestFilters.projectId, project.id),
      })
    ).length,
    0,
  );
});

function appFor(userId: string, orgId: string) {
  const app = new Hono<{ Variables: Vars }>();
  app.use("*", (c, next) => {
    c.set("userId", userId);
    c.set("orgId", orgId);
    return next();
  });
  mountIngestFilters(app);
  return app;
}

const getState = async (app: Hono<{ Variables: Vars }>, projectId: string) =>
  (await (
    await app.request(`/api/projects/${projectId}/ingest-filters`)
  ).json()) as IngestFilterState;

test("defaults to everything enabled (no rows)", async () => {
  const { org, user, project } = await seedProject();
  const app = appFor(user.id, org.id);
  assert.deepEqual(await getState(app, project.id), {
    otlp: { traces: true, logs: true, metrics: true },
    aws: { logs: true, metrics: true },
    gcp: { logs: true, metrics: true },
    vercel: { traces: true, logs: true },
    railway: { logs: true, metrics: true },
    render: { logs: true, metrics: true },
  });
});

test("PUT disables a pair, persists one sparse row, and reflects in GET", async () => {
  const { org, user, project } = await seedProject();
  const app = appFor(user.id, org.id);

  const desired: IngestFilterState = {
    otlp: { traces: true, logs: true, metrics: true },
    aws: { logs: false, metrics: true },
    gcp: { logs: true, metrics: true },
    vercel: { traces: true, logs: true },
    railway: { logs: true, metrics: true },
    render: { logs: true, metrics: true },
  };
  const res = await app.request(`/api/projects/${project.id}/ingest-filters`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(desired),
  });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as IngestFilterState).aws.logs, false);

  // Exactly one sparse row for the disabled pair.
  const rows = await db.query.projectIngestFilters.findMany({
    where: eq(schema.projectIngestFilters.projectId, project.id),
  });
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { source: rows[0]?.source, signal: rows[0]?.signal },
    {
      source: "aws",
      signal: "logs",
    },
  );
  assert.deepEqual(await getState(app, project.id), desired);
});

test("PUT is a full replace — re-enabling clears the row", async () => {
  const { org, user, project } = await seedProject();
  const app = appFor(user.id, org.id);
  const put = (state: IngestFilterState) =>
    app.request(`/api/projects/${project.id}/ingest-filters`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(state),
    });

  await put({
    otlp: { traces: false, logs: true, metrics: true },
    aws: { logs: false, metrics: true },
    gcp: { logs: true, metrics: true },
    vercel: { traces: true, logs: true },
    railway: { logs: true, metrics: true },
    render: { logs: true, metrics: true },
  });
  await put({
    otlp: { traces: true, logs: true, metrics: true },
    aws: { logs: true, metrics: true },
    gcp: { logs: true, metrics: true },
    vercel: { traces: true, logs: true },
    railway: { logs: true, metrics: true },
    render: { logs: true, metrics: true },
  });
  const rows = await db.query.projectIngestFilters.findMany({
    where: eq(schema.projectIngestFilters.projectId, project.id),
  });
  assert.equal(rows.length, 0);
});

test("rejects a malformed body (400)", async () => {
  const { org, user, project } = await seedProject();
  const app = appFor(user.id, org.id);
  const res = await app.request(`/api/projects/${project.id}/ingest-filters`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ otlp: { traces: true } }),
  });
  assert.equal(res.status, 400);
});
