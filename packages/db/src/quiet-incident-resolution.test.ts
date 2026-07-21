import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { DB } from "./client.js";
import * as schema from "./schema.js";

process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";
const { createIncidentLifecycle } = await import("./resolve-incident.js");

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");
const NOW = new Date("2026-07-21T03:00:00.000Z");
const CUTOFF = new Date("2026-07-07T03:00:00.000Z");

function one<T>(rows: T[]): T {
  const row = rows[0];
  assert.ok(row);
  return row;
}

test("quiet resolution rechecks current issues atomically before closing", async () => {
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as DB;
  await migrate(db as never, { migrationsFolder: MIGRATIONS });

  try {
    const org = one(
      await db.insert(schema.orgs).values({ name: "Acme", slug: "acme" }).returning(),
    );
    const project = one(
      await db
        .insert(schema.projects)
        .values({ orgId: org.id, name: "Shop", slug: "shop" })
        .returning(),
    );
    const incident = one(
      await db
        .insert(schema.incidents)
        .values({
          projectId: project.id,
          title: "Checkout failures",
          firstSeen: new Date("2026-06-01T00:00:00.000Z"),
          lastSeen: new Date("2026-07-08T03:00:00.000Z"),
        })
        .returning(),
    );
    const issues = await db
      .insert(schema.issues)
      .values([
        {
          projectId: project.id,
          fingerprint: "old",
          kind: "log" as const,
          exceptionType: "Error",
          title: "Old error",
          firstSeen: new Date("2026-06-01T00:00:00.000Z"),
          lastSeen: CUTOFF,
        },
        {
          projectId: project.id,
          fingerprint: "recent",
          kind: "log" as const,
          exceptionType: "Error",
          title: "Recent error",
          firstSeen: new Date("2026-06-01T00:00:00.000Z"),
          lastSeen: new Date("2026-07-08T03:00:00.000Z"),
        },
      ])
      .returning();
    await db
      .insert(schema.incidentIssues)
      .values(issues.map((issue) => ({ incidentId: incident.id, issueId: issue.id })));

    const result = await createIncidentLifecycle(db).resolveIfAllIssuesQuiet({
      incidentId: incident.id,
      cutoff: CUTOFF,
      resolvedAt: NOW,
      kind: "auto_inactivity",
      reasonCode: "no_issue_recurrence_14d",
      reasonText: "No linked issue recurred for 14 days.",
    });

    assert.deepEqual(result, { disposition: "recent_recurrence" });
    const after = one(
      await db.select().from(schema.incidents).where(eq(schema.incidents.id, incident.id)),
    );
    assert.equal(after.status, "open");

    const recentIssue = issues.find((issue) => issue.fingerprint === "recent");
    assert.ok(recentIssue);
    await db
      .update(schema.issues)
      .set({ lastSeen: CUTOFF })
      .where(eq(schema.issues.id, recentIssue.id));

    const resolved = await createIncidentLifecycle(db).resolveIfAllIssuesQuiet({
      incidentId: incident.id,
      cutoff: CUTOFF,
      resolvedAt: NOW,
      kind: "auto_inactivity",
      reasonCode: "no_issue_recurrence_14d",
      reasonText: "No linked issue recurred for 14 days.",
    });

    assert.deepEqual(resolved, {
      disposition: "resolved",
      linkedIssueCount: 2,
      quietSince: CUTOFF,
    });
    const closed = one(
      await db.select().from(schema.incidents).where(eq(schema.incidents.id, incident.id)),
    );
    assert.equal(closed.status, "resolved");
    assert.equal(closed.resolvedByKind, "auto_inactivity");
    const issueRows = await db.select().from(schema.issues);
    assert.deepEqual(
      issueRows.map((issue) => issue.status),
      ["resolved", "resolved"],
    );
  } finally {
    await client.close();
  }
});
