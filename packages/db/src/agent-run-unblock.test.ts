import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { unblockAgentRunsAfterGithubAccess } from "./agent-run-unblock.js";
import type { DB } from "./client.js";
import * as schema from "./schema.js";

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");
const NOW = new Date("2026-07-15T10:00:00.000Z");

async function freshDb(): Promise<{ db: DB; client: PGlite }> {
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as DB;
  await migrate(db as never, { migrationsFolder: MIGRATIONS });
  return { db, client };
}

test("GitHub access only unblocks runs whose locked Incidents are still open", async () => {
  const { db, client } = await freshDb();
  try {
    const [org] = await db
      .insert(schema.orgs)
      .values({ name: "Acme", slug: `acme-${crypto.randomUUID()}` })
      .returning();
    assert.ok(org);
    const [project] = await db
      .insert(schema.projects)
      .values({ orgId: org.id, name: "Project", slug: `project-${crypto.randomUUID()}` })
      .returning();
    assert.ok(project);
    const incidents = await db
      .insert(schema.incidents)
      .values([
        {
          projectId: project.id,
          title: "Open incident",
          codename: `open-${crypto.randomUUID()}`,
          status: "open",
          firstSeen: NOW,
          lastSeen: NOW,
        },
        {
          projectId: project.id,
          title: "Resolved incident",
          codename: `resolved-${crypto.randomUUID()}`,
          status: "resolved",
          firstSeen: NOW,
          lastSeen: NOW,
          resolvedAt: NOW,
          resolvedByKind: "dashboard_manual",
          resolvedReasonCode: "problem_resolved",
        },
      ])
      .returning();
    const openIncident = incidents.find((incident) => incident.status === "open");
    const resolvedIncident = incidents.find((incident) => incident.status === "resolved");
    assert.ok(openIncident);
    assert.ok(resolvedIncident);
    const runs = await db
      .insert(schema.agentRuns)
      .values([
        {
          incidentId: openIncident.id,
          runtime: "test",
          state: "blocked_no_github",
        },
        {
          incidentId: resolvedIncident.id,
          runtime: "test",
          state: "blocked_no_github",
        },
      ])
      .returning();

    const result = await unblockAgentRunsAfterGithubAccess(db, {
      projectIds: [project.id],
      trigger: "github_install",
      now: NOW,
    });

    assert.equal(result.unblockedCount, 1);
    const after = await db.query.agentRuns.findMany();
    assert.equal(after.find((run) => run.id === runs[0]?.id)?.state, "queued");
    assert.equal(after.find((run) => run.id === runs[1]?.id)?.state, "blocked_no_github");
    const events = await db.query.incidentEvents.findMany({
      where: eq(schema.incidentEvents.kind, "unblocked"),
    });
    assert.deepEqual(
      events.map((event) => event.agentRunId),
      [runs[0]?.id],
    );
  } finally {
    await client.close();
  }
});
