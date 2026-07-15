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

test("local reconciliation time cannot hide later provider close and reopen observations", async () => {
  const { db, client } = await freshDb();
  try {
    const { incident, pullRequest } = await seedPullRequest(db);
    const localReconciliationAt = new Date("2026-07-15T10:05:00.987Z");
    await db
      .update(schema.agentPullRequests)
      .set({ lastSyncedAt: localReconciliationAt })
      .where(eq(schema.agentPullRequests.id, pullRequest.id));

    const providerClosedAt = new Date("2026-07-15T10:00:01.000Z");
    const closed = await applyAgentPullRequestState(db, {
      incidentId: incident.id,
      agentPrId: pullRequest.id,
      targetState: "closed",
      observedAt: new Date("2026-07-15T10:05:01.123Z"),
      providerUpdatedAt: providerClosedAt,
      closedAt: providerClosedAt,
    });
    assert.equal(closed.stateChanged, true);
    assert.equal(closed.pullRequest?.state, "closed");

    const providerReopenedAt = new Date("2026-07-15T10:00:02.000Z");
    const reopened = await applyAgentPullRequestState(db, {
      incidentId: incident.id,
      agentPrId: pullRequest.id,
      targetState: "open",
      observedAt: new Date("2026-07-15T10:05:02.456Z"),
      providerUpdatedAt: providerReopenedAt,
      closedAt: null,
    });
    assert.equal(reopened.stateChanged, true);
    assert.equal(reopened.pullRequest?.state, "open");

    const staleClose = await applyAgentPullRequestState(db, {
      incidentId: incident.id,
      agentPrId: pullRequest.id,
      targetState: "closed",
      observedAt: new Date("2026-07-15T10:05:03.789Z"),
      providerUpdatedAt: providerClosedAt,
      closedAt: providerClosedAt,
    });
    assert.equal(staleClose.stateChanged, false);
    assert.equal(staleClose.pullRequest?.state, "open");

    const after = await db.query.agentPullRequests.findFirst({
      where: eq(schema.agentPullRequests.id, pullRequest.id),
    });
    assert.equal(after?.state, "open");
    assert.equal(after?.providerUpdatedAt?.toISOString(), providerReopenedAt.toISOString());
    assert.equal(after?.lastSyncedAt?.toISOString(), "2026-07-15T10:05:02.456Z");
  } finally {
    await client.close();
  }
});

test("a newer metadata observation cannot hide a delayed provider close", async () => {
  const { db, client } = await freshDb();
  try {
    const { incident, pullRequest } = await seedPullRequest(db);
    const providerClosedAt = new Date("2026-07-15T10:00:01.000Z");
    const providerEditedAt = new Date("2026-07-15T10:00:02.000Z");

    const edited = await applyAgentPullRequestState(db, {
      incidentId: incident.id,
      agentPrId: pullRequest.id,
      observedAt: new Date("2026-07-15T10:05:02.000Z"),
      providerUpdatedAt: providerEditedAt,
      title: "Updated title",
    });
    assert.equal(edited.pullRequest?.title, "Updated title");
    assert.equal(edited.pullRequest?.providerUpdatedAt, null);

    const delayedClose = await applyAgentPullRequestState(db, {
      incidentId: incident.id,
      agentPrId: pullRequest.id,
      targetState: "closed",
      observedAt: new Date("2026-07-15T10:05:03.000Z"),
      providerUpdatedAt: providerClosedAt,
      closedAt: providerClosedAt,
    });

    assert.equal(delayedClose.stateChanged, true);
    assert.equal(delayedClose.pullRequest?.state, "closed");
    assert.equal(delayedClose.pullRequest?.title, "Updated title");
    assert.equal(
      delayedClose.pullRequest?.providerUpdatedAt?.toISOString(),
      providerClosedAt.toISOString(),
    );
  } finally {
    await client.close();
  }
});

test("a newer metadata observation cannot hide a delayed provider reopen", async () => {
  const { db, client } = await freshDb();
  try {
    const { incident, pullRequest } = await seedPullRequest(db);
    const providerInitiallyClosedAt = new Date("2026-07-15T10:00:00.000Z");
    const providerReopenedAt = new Date("2026-07-15T10:00:01.000Z");
    const providerEditedAt = new Date("2026-07-15T10:00:02.000Z");

    await applyAgentPullRequestState(db, {
      incidentId: incident.id,
      agentPrId: pullRequest.id,
      targetState: "closed",
      observedAt: new Date("2026-07-15T10:05:00.000Z"),
      providerUpdatedAt: providerInitiallyClosedAt,
      closedAt: providerInitiallyClosedAt,
    });
    const edited = await applyAgentPullRequestState(db, {
      incidentId: incident.id,
      agentPrId: pullRequest.id,
      observedAt: new Date("2026-07-15T10:05:02.000Z"),
      providerUpdatedAt: providerEditedAt,
      title: "Updated title",
    });
    assert.equal(edited.pullRequest?.title, "Updated title");
    assert.equal(
      edited.pullRequest?.providerUpdatedAt?.toISOString(),
      providerInitiallyClosedAt.toISOString(),
    );

    const delayedReopen = await applyAgentPullRequestState(db, {
      incidentId: incident.id,
      agentPrId: pullRequest.id,
      targetState: "open",
      observedAt: new Date("2026-07-15T10:05:03.000Z"),
      providerUpdatedAt: providerReopenedAt,
      closedAt: null,
    });

    assert.equal(delayedReopen.stateChanged, true);
    assert.equal(delayedReopen.pullRequest?.state, "open");
    assert.equal(delayedReopen.pullRequest?.closedAt, null);
    assert.equal(delayedReopen.pullRequest?.title, "Updated title");
    assert.equal(
      delayedReopen.pullRequest?.providerUpdatedAt?.toISOString(),
      providerReopenedAt.toISOString(),
    );
  } finally {
    await client.close();
  }
});

test("an equal provider timestamp with conflicting state requires authoritative reconciliation", async () => {
  const { db, client } = await freshDb();
  try {
    const { incident, pullRequest } = await seedPullRequest(db);
    const providerUpdatedAt = new Date("2026-07-15T10:00:01.000Z");
    await db
      .update(schema.agentPullRequests)
      .set({ providerUpdatedAt })
      .where(eq(schema.agentPullRequests.id, pullRequest.id));

    const result = await applyAgentPullRequestState(db, {
      incidentId: incident.id,
      agentPrId: pullRequest.id,
      targetState: "closed",
      observedAt: new Date("2026-07-15T10:05:01.000Z"),
      providerUpdatedAt,
      closedAt: providerUpdatedAt,
    });

    assert.equal(result.providerReconciliationRequired, true);
    assert.equal(result.stateChanged, false);
    assert.equal(result.pullRequest?.state, "open");
    const after = await db.query.agentPullRequests.findFirst({
      where: eq(schema.agentPullRequests.id, pullRequest.id),
    });
    assert.equal(after?.state, "open");
  } finally {
    await client.close();
  }
});

test("an equal provider timestamp also reconciles a conflicting reopen", async () => {
  const { db, client } = await freshDb();
  try {
    const { incident, pullRequest } = await seedPullRequest(db);
    const providerUpdatedAt = new Date("2026-07-15T10:00:01.000Z");
    await db
      .update(schema.agentPullRequests)
      .set({ state: "closed", providerUpdatedAt, closedAt: providerUpdatedAt })
      .where(eq(schema.agentPullRequests.id, pullRequest.id));

    const result = await applyAgentPullRequestState(db, {
      incidentId: incident.id,
      agentPrId: pullRequest.id,
      targetState: "open",
      observedAt: new Date("2026-07-15T10:05:01.000Z"),
      providerUpdatedAt,
      closedAt: null,
    });

    assert.equal(result.providerReconciliationRequired, true);
    assert.equal(result.stateChanged, false);
    assert.equal(result.pullRequest?.state, "closed");
    assert.equal(result.pullRequest?.closedAt?.toISOString(), providerUpdatedAt.toISOString());
  } finally {
    await client.close();
  }
});

test("an authoritative provider snapshot resolves an equal-timestamp state conflict", async () => {
  const { db, client } = await freshDb();
  try {
    const { incident, pullRequest } = await seedPullRequest(db);
    const providerUpdatedAt = new Date("2026-07-15T10:00:01.000Z");
    await db
      .update(schema.agentPullRequests)
      .set({ providerUpdatedAt })
      .where(eq(schema.agentPullRequests.id, pullRequest.id));

    const result = await applyAgentPullRequestState(db, {
      incidentId: incident.id,
      agentPrId: pullRequest.id,
      targetState: "closed",
      observedAt: new Date("2026-07-15T10:05:01.000Z"),
      providerUpdatedAt,
      providerSnapshotAuthoritative: true,
      closedAt: providerUpdatedAt,
    });

    assert.equal(result.providerReconciliationRequired, false);
    assert.equal(result.stateChanged, true);
    assert.equal(result.pullRequest?.state, "closed");
  } finally {
    await client.close();
  }
});
