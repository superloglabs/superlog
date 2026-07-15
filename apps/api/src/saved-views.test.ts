import "dotenv/config";
import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import { closeDb, db, runMigrations, schema } from "@superlog/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { mountSavedViews } from "./saved-views/interfaces.js";

type SavedViewBody = {
  id: string;
  name: string;
  visibility: "personal" | "workspace";
  state: {
    source: "logs" | "traces";
    range: { type: "relative"; seconds: number; label: string };
    attrs: { key: string; value: string }[];
    severity?: string;
    groupBy?: string;
  };
  ownedByMe: boolean;
};

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

async function seedProject() {
  const tag = `saved-view-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const [org] = await db.insert(schema.orgs).values({ name: tag, slug: tag }).returning();
  if (!org) throw new Error("seed org failed");
  orgIds.push(org.id);
  const [user] = await db
    .insert(schema.users)
    .values({ email: `${tag}@example.com`, name: "View owner" })
    .returning();
  if (!user) throw new Error("seed user failed");
  await db.insert(schema.orgMembers).values({ orgId: org.id, userId: user.id, role: "owner" });
  const [project] = await db
    .insert(schema.projects)
    .values({ orgId: org.id, name: "Default", slug: "default" })
    .returning();
  if (!project) throw new Error("seed project failed");
  return { org, user, project };
}

function appFor(userId: string, orgId: string) {
  const app = new Hono<{ Variables: { userId: string; orgId: string | null } }>();
  app.use("*", (c, next) => {
    c.set("userId", userId);
    c.set("orgId", orgId);
    return next();
  });
  mountSavedViews(app);
  return app;
}

test("a project member can save and list a personal log view", async () => {
  const { org, user, project } = await seedProject();
  const app = appFor(user.id, org.id);
  const state = {
    source: "logs" as const,
    range: { type: "relative" as const, seconds: 1800, label: "Last 30 min" },
    attrs: [
      { key: "service.name", value: "api" },
      { key: "deployment.environment", value: "production" },
    ],
    severity: "ERROR",
    groupBy: "service.name",
  };

  const createResponse = await app.request(`/api/projects/${project.id}/saved-views`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Production errors", visibility: "personal", state }),
  });

  assert.equal(createResponse.status, 200);
  const created = (await createResponse.json()) as SavedViewBody;
  assert.equal(created.name, "Production errors");
  assert.equal(created.visibility, "personal");
  assert.equal(created.ownedByMe, true);
  assert.deepEqual(created.state, state);

  const listResponse = await app.request(`/api/projects/${project.id}/saved-views`);
  assert.equal(listResponse.status, 200);
  const listed = (await listResponse.json()) as SavedViewBody[];
  assert.deepEqual(
    listed.map((view) => ({ id: view.id, name: view.name, ownedByMe: view.ownedByMe })),
    [{ id: created.id, name: "Production errors", ownedByMe: true }],
  );
});

test("workspace views are shared with project members while personal views stay private", async () => {
  const { org, user, project } = await seedProject();
  const [teammate] = await db
    .insert(schema.users)
    .values({ email: `teammate-${Date.now()}@example.com`, name: "Teammate" })
    .returning();
  if (!teammate) throw new Error("seed teammate failed");
  await db.insert(schema.orgMembers).values({ orgId: org.id, userId: teammate.id, role: "member" });

  const ownerApp = appFor(user.id, org.id);
  const state = {
    source: "traces" as const,
    range: { type: "relative" as const, seconds: 3600, label: "Last 1 hour" },
    attrs: [{ key: "service.name", value: "checkout-api" }],
    statusCode: "STATUS_CODE_ERROR",
    tracesView: "traces" as const,
  };
  for (const [name, visibility] of [
    ["My slow traces", "personal"],
    ["Payment failures", "workspace"],
  ] as const) {
    const response = await ownerApp.request(`/api/projects/${project.id}/saved-views`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, visibility, state }),
    });
    assert.equal(response.status, 200);
  }

  const teammateApp = appFor(teammate.id, org.id);
  const response = await teammateApp.request(`/api/projects/${project.id}/saved-views`);
  assert.equal(response.status, 200);
  const listed = (await response.json()) as SavedViewBody[];
  assert.deepEqual(
    listed.map((view) => ({
      name: view.name,
      visibility: view.visibility,
      ownedByMe: view.ownedByMe,
    })),
    [{ name: "Payment failures", visibility: "workspace", ownedByMe: false }],
  );
});

test("only the creator can update a saved view", async () => {
  const { org, user, project } = await seedProject();
  const [teammate] = await db
    .insert(schema.users)
    .values({ email: `saved-view-editor-${Date.now()}@example.com`, name: "Teammate" })
    .returning();
  if (!teammate) throw new Error("seed teammate failed");
  await db.insert(schema.orgMembers).values({ orgId: org.id, userId: teammate.id, role: "member" });

  const ownerApp = appFor(user.id, org.id);
  const initialState = {
    source: "logs" as const,
    range: { type: "relative" as const, seconds: 1800, label: "Last 30 min" },
    attrs: [{ key: "service.name", value: "api" }],
    severity: "ERROR",
  };
  const createdResponse = await ownerApp.request(`/api/projects/${project.id}/saved-views`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Production errors",
      visibility: "workspace",
      state: initialState,
    }),
  });
  const created = (await createdResponse.json()) as SavedViewBody;

  const teammateApp = appFor(teammate.id, org.id);
  const forbidden = await teammateApp.request(
    `/api/projects/${project.id}/saved-views/${created.id}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed by teammate", state: initialState }),
    },
  );
  assert.equal(forbidden.status, 403);

  const nextState = {
    ...initialState,
    attrs: [...initialState.attrs, { key: "deployment.environment", value: "production" }],
  };
  const updatedResponse = await ownerApp.request(
    `/api/projects/${project.id}/saved-views/${created.id}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Production API errors", state: nextState }),
    },
  );
  assert.equal(updatedResponse.status, 200);
  const updated = (await updatedResponse.json()) as SavedViewBody;
  assert.equal(updated.name, "Production API errors");
  assert.deepEqual(updated.state, nextState);
  assert.equal(updated.visibility, "workspace");
});

test("only the creator can delete a saved view", async () => {
  const { org, user, project } = await seedProject();
  const [teammate] = await db
    .insert(schema.users)
    .values({ email: `saved-view-delete-${Date.now()}@example.com`, name: "Teammate" })
    .returning();
  if (!teammate) throw new Error("seed teammate failed");
  await db.insert(schema.orgMembers).values({ orgId: org.id, userId: teammate.id, role: "member" });

  const ownerApp = appFor(user.id, org.id);
  const createdResponse = await ownerApp.request(`/api/projects/${project.id}/saved-views`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Production errors",
      visibility: "workspace",
      state: {
        source: "logs",
        range: { type: "relative", seconds: 1800, label: "Last 30 min" },
        attrs: [],
        severity: "ERROR",
      },
    }),
  });
  const created = (await createdResponse.json()) as SavedViewBody;

  const teammateApp = appFor(teammate.id, org.id);
  const forbidden = await teammateApp.request(
    `/api/projects/${project.id}/saved-views/${created.id}`,
    { method: "DELETE" },
  );
  assert.equal(forbidden.status, 403);

  const deleted = await ownerApp.request(`/api/projects/${project.id}/saved-views/${created.id}`, {
    method: "DELETE",
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { ok: true });

  const listed = await ownerApp.request(`/api/projects/${project.id}/saved-views`);
  assert.deepEqual(await listed.json(), []);
});
