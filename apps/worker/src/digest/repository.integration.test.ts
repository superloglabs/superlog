import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { type DB, schema } from "@superlog/db";
import { eq } from "drizzle-orm";
import { type PgliteDatabase, drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createDigestRepository } from "./repository.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(HERE, "../../../../packages/db/migrations");
const REQUESTED_AT = new Date("2026-07-14T10:00:00Z");
const COMPLETED_AT = new Date("2026-07-14T10:01:00Z");

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let repo: ReturnType<typeof createDigestRepository>;
let projectId: string;

before(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  repo = createDigestRepository(db as unknown as DB);

  const [org] = await db.insert(schema.orgs).values({ name: "Acme", slug: "acme" }).returning();
  assert.ok(org);
  const [project] = await db
    .insert(schema.projects)
    .values({ orgId: org.id, name: "Default", slug: "default" })
    .returning();
  assert.ok(project);
  projectId = project.id;
  await db.insert(schema.projectAutomationSettings).values({
    projectId,
    digestRunRequestedAt: REQUESTED_AT,
  });
});

after(async () => {
  await client.close();
});

test("stamping a completed digest preserves a newer one-shot request", async () => {
  await repo.stampLastRun(projectId, COMPLETED_AT);

  const row = await db.query.projectAutomationSettings.findFirst({
    where: eq(schema.projectAutomationSettings.projectId, projectId),
  });
  assert.equal(row?.digestLastRunAt?.toISOString(), COMPLETED_AT.toISOString());
  assert.equal(row?.digestRunRequestedAt?.toISOString(), REQUESTED_AT.toISOString());
});

test("clearing a one-shot request only consumes the request selected by the tick", async () => {
  const newerRequest = new Date("2026-07-14T10:02:00Z");
  await db
    .update(schema.projectAutomationSettings)
    .set({ digestRunRequestedAt: newerRequest })
    .where(eq(schema.projectAutomationSettings.projectId, projectId));

  await repo.clearRunRequest(projectId, REQUESTED_AT);

  const afterStaleClear = await db.query.projectAutomationSettings.findFirst({
    where: eq(schema.projectAutomationSettings.projectId, projectId),
  });
  assert.equal(afterStaleClear?.digestRunRequestedAt?.toISOString(), newerRequest.toISOString());

  await repo.clearRunRequest(projectId, newerRequest);
  const afterMatchingClear = await db.query.projectAutomationSettings.findFirst({
    where: eq(schema.projectAutomationSettings.projectId, projectId),
  });
  assert.equal(afterMatchingClear?.digestRunRequestedAt, null);
});
