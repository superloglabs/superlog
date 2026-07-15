import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { applyAgentPullRequestState } from "./agent-pr-state.js";
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

async function seedPullRequest(db: DB) {
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
  const [incident] = await db
    .insert(schema.incidents)
    .values({
      projectId: project.id,
      title: "PR lifecycle",
      codename: `pr-${crypto.randomUUID()}`,
      firstSeen: NOW,
      lastSeen: NOW,
    })
    .returning();
  assert.ok(incident);
  const [run] = await db
    .insert(schema.agentRuns)
    .values({ incidentId: incident.id, runtime: "test", state: "awaiting_events" })
    .returning();
  assert.ok(run);
  const [installation] = await db
    .insert(schema.githubInstallations)
    .values({
      orgId: org.id,
      projectId: project.id,
      installationId: Math.floor(Math.random() * 1_000_000) + 1,
      accountLogin: "acme",
      accountType: "Organization",
      repos: [],
    })
    .returning();
  assert.ok(installation);
  const [pullRequest] = await db
    .insert(schema.agentPullRequests)
    .values({
      incidentId: incident.id,
      agentRunId: run.id,
      installationId: installation.id,
      repoFullName: `acme/api-${crypto.randomUUID()}`,
      prNumber: 42,
      url: "https://github.com/acme/api/pull/42",
      branchName: "ash/fix-api",
      baseBranch: "main",
      state: "open",
    })
    .returning();
  assert.ok(pullRequest);
  return { incident, pullRequest };
}

test("a delayed close or reopen delivery cannot regress a merged PR", async () => {
  const { db, client } = await freshDb();
  try {
    const { incident, pullRequest } = await seedPullRequest(db);
    const mergedAt = new Date(NOW.getTime() + 1_000);
    const merged = await applyAgentPullRequestState(db, {
      incidentId: incident.id,
      agentPrId: pullRequest.id,
      targetState: "merged",
      observedAt: mergedAt,
      mergedAt,
      closedAt: mergedAt,
      mergedByLogin: "alice",
    });
    assert.equal(merged.stateChanged, true);

    const delayedClose = await applyAgentPullRequestState(db, {
      incidentId: incident.id,
      agentPrId: pullRequest.id,
      targetState: "closed",
      observedAt: new Date(NOW.getTime() + 2_000),
      closedAt: new Date(NOW.getTime() + 2_000),
    });
    const delayedReopen = await applyAgentPullRequestState(db, {
      incidentId: incident.id,
      agentPrId: pullRequest.id,
      targetState: "open",
      observedAt: new Date(NOW.getTime() + 3_000),
      closedAt: null,
    });

    assert.equal(delayedClose.stateChanged, false);
    assert.equal(delayedReopen.stateChanged, false);
    const after = await db.query.agentPullRequests.findFirst({
      where: eq(schema.agentPullRequests.id, pullRequest.id),
    });
    assert.equal(after?.state, "merged");
    assert.equal(after?.mergedByLogin, "alice");
    assert.equal(after?.mergedAt?.toISOString(), mergedAt.toISOString());
    assert.equal(after?.closedAt?.toISOString(), mergedAt.toISOString());
  } finally {
    await client.close();
  }
});

test("reopened changes state only from closed to open", async () => {
  const { db, client } = await freshDb();
  try {
    const { incident, pullRequest } = await seedPullRequest(db);

    const alreadyOpen = await applyAgentPullRequestState(db, {
      incidentId: incident.id,
      agentPrId: pullRequest.id,
      targetState: "open",
      observedAt: NOW,
    });
    assert.equal(alreadyOpen.stateChanged, false);

    const closedAt = new Date(NOW.getTime() + 1_000);
    const closed = await applyAgentPullRequestState(db, {
      incidentId: incident.id,
      agentPrId: pullRequest.id,
      targetState: "closed",
      observedAt: closedAt,
      closedAt,
    });
    assert.equal(closed.stateChanged, true);
    assert.equal(closed.pullRequest?.state, "closed");

    const reopened = await applyAgentPullRequestState(db, {
      incidentId: incident.id,
      agentPrId: pullRequest.id,
      targetState: "open",
      observedAt: new Date(NOW.getTime() + 2_000),
    });
    assert.equal(reopened.stateChanged, true);
    assert.equal(reopened.pullRequest?.state, "open");
    assert.equal(reopened.pullRequest?.closedAt, null);
  } finally {
    await client.close();
  }
});
