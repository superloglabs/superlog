import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { DB } from "./client.js";
import * as schema from "./schema.js";

process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";
const { classifyIncidentIssue } = await import("./issue-classification.js");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(HERE, "../migrations");

function one<T>(rows: T[]): T {
  const row = rows[0];
  assert.ok(row, "expected a row");
  return row;
}

async function freshDb(): Promise<{ db: DB; client: PGlite }> {
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as DB;
  await migrate(db as never, { migrationsFolder: MIGRATIONS });
  return { db, client };
}

async function seedProject(db: DB) {
  const org = one(await db.insert(schema.orgs).values({ name: "Acme", slug: "acme" }).returning());
  const project = one(
    await db.insert(schema.projects).values({ orgId: org.id, name: "P", slug: "p" }).returning(),
  );
  return project;
}

// Returns { issue, incident } for an open incident linked to a fresh issue.
async function seedIssueAndIncident(db: DB, projectId: string) {
  const now = new Date();
  const issue = one(
    await db
      .insert(schema.issues)
      .values({
        projectId,
        fingerprint: "fp-1",
        kind: "error",
        exceptionType: "Error",
        title: "Test error",
        firstSeen: now,
        lastSeen: now,
      })
      .returning(),
  );
  const incident = one(
    await db
      .insert(schema.incidents)
      .values({
        projectId,
        title: "Test incident",
        status: "open",
        firstSeen: now,
        lastSeen: now,
      })
      .returning(),
  );
  await db.insert(schema.incidentIssues).values({ incidentId: incident.id, issueId: issue.id });
  return { issue, incident };
}

// Truncated / non-UUID issueId must return a structured issue_not_found result
// WITHOUT throwing, so the caller can ack a clean tool error instead of an
// unexpected exception that bypasses the structured error path.
test("returns issue_not_found for a truncated (non-UUID) issueId without querying the DB", async () => {
  const { db, client } = await freshDb();
  try {
    const project = await seedProject(db);
    const { incident } = await seedIssueAndIncident(db, project.id);

    for (const badId of ["c5333217", "not-a-uuid", "", "b61765fe-e363-4098-86af"]) {
      const result = await classifyIncidentIssue(db, {
        incidentId: incident.id,
        issueId: badId,
        action: { kind: "observe", trigger: { kind: "count", count: 5 } },
        reason: "test",
        evidence: "test",
      });
      assert.equal(result.ok, false, `expected ok=false for issueId=${JSON.stringify(badId)}`);
      if (!result.ok) {
        assert.equal(result.error, "issue_not_found", badId);
        assert.ok(result.message.includes("incident issue bundle"), badId);
      }
    }
  } finally {
    await client.close();
  }
});

test("successfully classifies an issue with a valid UUID issueId", async () => {
  const { db, client } = await freshDb();
  try {
    const project = await seedProject(db);
    const { issue, incident } = await seedIssueAndIncident(db, project.id);

    const result = await classifyIncidentIssue(db, {
      incidentId: incident.id,
      issueId: issue.id,
      action: { kind: "silence" },
      reason: "noise",
      evidence: "no user impact",
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.status, "silenced");
      assert.equal(result.alreadyClassified, false);
    }
  } finally {
    await client.close();
  }
});
