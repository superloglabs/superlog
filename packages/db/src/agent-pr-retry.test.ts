import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { requestFollowUpAgentRun, restartAgentRun } from "./agent-follow-up.js";
import { queueAgentPullRequestRetry } from "./agent-pr-retry.js";
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

async function seedRetryableRun(db: DB, incidentStatus: schema.IncidentStatus = "open") {
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
      title: "Retry PR delivery",
      codename: `retry-${crypto.randomUUID()}`,
      status: incidentStatus,
      firstSeen: NOW,
      lastSeen: NOW,
      ...(incidentStatus === "resolved"
        ? {
            resolvedAt: NOW,
            resolvedByKind: "dashboard_manual" as const,
            resolvedReasonCode: "problem_resolved",
          }
        : {}),
    })
    .returning();
  assert.ok(incident);
  const [agentRun] = await db
    .insert(schema.agentRuns)
    .values({
      incidentId: incident.id,
      runtime: "test",
      state: "failed",
      failureReason: "pr_open_failed",
      // Pin createdAt: the "latest run" ordering compares it against
      // successors the tests create at NOW + ε, so leaving the column on its
      // wall-clock default made those successors stop being "newer" the
      // moment real time passed the fixture NOW.
      createdAt: NOW,
      completedAt: NOW,
      result: {
        state: "failed",
        summary: "PR delivery failed.",
        pr: {
          selectedRepoFullName: "acme/api",
          branchName: "ash/fix-api",
          baseBranch: "main",
          patch: "diff --git a/a.ts b/a.ts\n",
          openStatus: "pending",
        },
      },
    })
    .returning();
  assert.ok(agentRun);
  return { incident, agentRun };
}

test("PR delivery retry cannot reactivate a run after its Incident resolves", async () => {
  const { db, client } = await freshDb();
  try {
    const { incident, agentRun } = await seedRetryableRun(db, "resolved");

    const result = await queueAgentPullRequestRetry(db, {
      incidentId: incident.id,
      agentRunId: agentRun.id,
      now: NOW,
    });

    assert.deepEqual(result, { outcome: "incident_not_open" });
    const after = await db.query.agentRuns.findFirst({
      where: eq(schema.agentRuns.id, agentRun.id),
    });
    assert.equal(after?.state, "failed");
  } finally {
    await client.close();
  }
});

test("PR delivery retry atomically queues the latest retryable failed run", async () => {
  const { db, client } = await freshDb();
  try {
    const { incident, agentRun } = await seedRetryableRun(db);

    const result = await queueAgentPullRequestRetry(db, {
      incidentId: incident.id,
      agentRunId: agentRun.id,
      now: NOW,
    });

    assert.equal(result.outcome, "queued");
    if (result.outcome !== "queued") return;
    assert.equal(result.agentRun.state, "pr_retry_queued");
    assert.equal(result.agentRun.failureReason, null);
    assert.equal(result.agentRun.completedAt, null);
    const event = await db.query.incidentEvents.findFirst({
      where: eq(schema.incidentEvents.agentRunId, agentRun.id),
    });
    assert.equal(event?.kind, "agent_run_pr_retry_queued");
    assert.equal(event?.incidentId, incident.id);
  } finally {
    await client.close();
  }
});

test("PR delivery retry rejects a failed predecessor once a newer run exists", async () => {
  const { db, client } = await freshDb();
  try {
    const { incident, agentRun } = await seedRetryableRun(db);
    const [successor] = await db
      .insert(schema.agentRuns)
      .values({
        incidentId: incident.id,
        runtime: "test",
        state: "queued",
        createdAt: new Date(NOW.getTime() + 1_000),
      })
      .returning();
    assert.ok(successor);

    const result = await queueAgentPullRequestRetry(db, {
      incidentId: incident.id,
      agentRunId: agentRun.id,
      now: NOW,
    });

    assert.deepEqual(result, { outcome: "agent_run_not_latest" });
    const runs = await db.query.agentRuns.findMany({
      where: eq(schema.agentRuns.incidentId, incident.id),
    });
    assert.equal(runs.find((run) => run.id === agentRun.id)?.state, "failed");
    assert.equal(runs.find((run) => run.id === successor.id)?.state, "queued");
  } finally {
    await client.close();
  }
});

test("PR delivery retry serializes with restart and leaves one viable successor", async () => {
  const { db, client } = await freshDb();
  try {
    const { incident, agentRun } = await seedRetryableRun(db);

    const [retry, restart] = await Promise.all([
      queueAgentPullRequestRetry(db, {
        incidentId: incident.id,
        agentRunId: agentRun.id,
        now: NOW,
      }),
      restartAgentRun(db, { incidentId: incident.id, runtime: "test", now: NOW }),
    ]);

    assert.ok(retry.outcome === "queued" || retry.outcome === "agent_run_not_latest");
    assert.equal(restart.outcome, "restarted");
    const runs = await db.query.agentRuns.findMany({
      where: eq(schema.agentRuns.incidentId, incident.id),
    });
    assert.equal(
      runs.filter((run) => !["complete", "failed", "superseded"].includes(run.state)).length,
      1,
    );
  } finally {
    await client.close();
  }
});

test("PR delivery retry serializes with follow-up creation", async () => {
  const { db, client } = await freshDb();
  try {
    const { incident, agentRun } = await seedRetryableRun(db);

    const [retry, followUp] = await Promise.all([
      queueAgentPullRequestRetry(db, {
        incidentId: incident.id,
        agentRunId: agentRun.id,
        now: NOW,
      }),
      requestFollowUpAgentRun(db, {
        incidentId: incident.id,
        trigger: "slack_reply",
        interaction: {
          channel: "slack_reply",
          author: "alice",
          text: "Please retry this fix.",
          occurredAt: NOW.toISOString(),
        },
        confirmed: true,
        now: NOW,
      }),
    ]);

    assert.ok(retry.outcome === "queued" || retry.outcome === "agent_run_not_latest");
    assert.ok(followUp.outcome === "enqueued" || followUp.outcome === "skipped");
    const runs = await db.query.agentRuns.findMany({
      where: eq(schema.agentRuns.incidentId, incident.id),
    });
    assert.equal(
      runs.filter((run) => !["complete", "failed", "superseded"].includes(run.state)).length,
      1,
    );
  } finally {
    await client.close();
  }
});
