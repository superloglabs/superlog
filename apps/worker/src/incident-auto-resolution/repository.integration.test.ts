import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { type DB, schema } from "@superlog/db";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createQuietIncidentResolutionRepository } from "./repository.js";

const MIGRATIONS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/migrations",
);
const CUTOFF = new Date("2026-07-07T03:00:00.000Z");

function one<T>(rows: T[]): T {
  const row = rows[0];
  assert.ok(row);
  return row;
}

test("candidate selection honors the project auto-resolution switch", async () => {
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as DB;
  await migrate(db as never, { migrationsFolder: MIGRATIONS });

  try {
    const org = one(
      await db.insert(schema.orgs).values({ name: "Acme", slug: "acme" }).returning(),
    );
    const enabledProject = one(
      await db
        .insert(schema.projects)
        .values({ orgId: org.id, name: "Enabled", slug: "enabled" })
        .returning(),
    );
    const disabledProject = one(
      await db
        .insert(schema.projects)
        .values({ orgId: org.id, name: "Disabled", slug: "disabled" })
        .returning(),
    );
    await db.insert(schema.projectAutomationSettings).values({
      projectId: disabledProject.id,
      autoResolveStaleIncidentsEnabled: false,
    });

    for (const project of [enabledProject, disabledProject]) {
      const issue = one(
        await db
          .insert(schema.issues)
          .values({
            projectId: project.id,
            fingerprint: `fingerprint-${project.slug}`,
            kind: "log",
            exceptionType: "Error",
            title: "Checkout error",
            firstSeen: new Date("2026-06-01T00:00:00.000Z"),
            lastSeen: CUTOFF,
          })
          .returning(),
      );
      const incident = one(
        await db
          .insert(schema.incidents)
          .values({
            projectId: project.id,
            title: "Checkout incident",
            firstSeen: issue.firstSeen,
            lastSeen: issue.lastSeen,
          })
          .returning(),
      );
      await db.insert(schema.incidentIssues).values({ incidentId: incident.id, issueId: issue.id });
    }

    const candidates = await createQuietIncidentResolutionRepository(db).listCandidates(CUTOFF);

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.linkedIssues.length, 1);
    assert.equal(candidates[0]?.linkedIssues[0]?.lastSeen.toISOString(), CUTOFF.toISOString());
  } finally {
    await client.close();
  }
});

test("resolution honors a project opt-out made after candidate selection", async () => {
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as DB;
  await migrate(db as never, { migrationsFolder: MIGRATIONS });

  try {
    const org = one(
      await db.insert(schema.orgs).values({ name: "Acme", slug: "acme-late-opt-out" }).returning(),
    );
    const project = one(
      await db
        .insert(schema.projects)
        .values({ orgId: org.id, name: "Project", slug: "late-opt-out" })
        .returning(),
    );
    const issue = one(
      await db
        .insert(schema.issues)
        .values({
          projectId: project.id,
          fingerprint: "late-opt-out",
          kind: "log",
          exceptionType: "Error",
          title: "Checkout error",
          firstSeen: new Date("2026-06-01T00:00:00.000Z"),
          lastSeen: CUTOFF,
        })
        .returning(),
    );
    const incident = one(
      await db
        .insert(schema.incidents)
        .values({
          projectId: project.id,
          title: "Checkout incident",
          firstSeen: issue.firstSeen,
          lastSeen: issue.lastSeen,
        })
        .returning(),
    );
    await db.insert(schema.incidentIssues).values({ incidentId: incident.id, issueId: issue.id });
    const repository = createQuietIncidentResolutionRepository(db);
    assert.equal((await repository.listCandidates(CUTOFF)).length, 1);

    await db.insert(schema.projectAutomationSettings).values({
      projectId: project.id,
      autoResolveStaleIncidentsEnabled: false,
    });
    const result = await repository.resolveIfStillQuiet({
      incidentId: incident.id,
      cutoff: CUTOFF,
      resolvedAt: new Date("2026-07-21T03:00:00.000Z"),
    });

    assert.deepEqual(result, { kind: "disabled" });
    const storedIncident = await db.query.incidents.findFirst({
      where: (table, { eq }) => eq(table.id, incident.id),
    });
    assert.equal(storedIncident?.status, "open");
  } finally {
    await client.close();
  }
});
