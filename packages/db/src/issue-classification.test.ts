import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { DB } from "./client.js";
import {
  classifyIncidentIssue,
  synthesizeLegacyIncidentIssueOutcomes,
} from "./issue-classification.js";
import * as schema from "./schema.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(HERE, "../migrations");

function one<T>(rows: T[]): T {
  const row = rows[0];
  assert.ok(row, "expected one row");
  return row;
}

async function freshDb(): Promise<{ db: DB; client: PGlite }> {
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as DB;
  await migrate(db as never, { migrationsFolder: MIGRATIONS });
  return { db, client };
}

test("legacy resolution reconstructs a complete outcome set from this run's classifications", async () => {
  const { db, client } = await freshDb();
  try {
    const org = one(
      await db.insert(schema.orgs).values({ name: "Acme", slug: "acme" }).returning(),
    );
    const project = one(
      await db.insert(schema.projects).values({ orgId: org.id, name: "P", slug: "p" }).returning(),
    );
    const now = new Date("2026-07-14T12:00:00.000Z");
    const incident = one(
      await db
        .insert(schema.incidents)
        .values({
          projectId: project.id,
          title: "Grouped checkout failures",
          codename: "legacy-outcomes",
          status: "open",
          firstSeen: now,
          lastSeen: now,
        })
        .returning(),
    );
    const issues = await db
      .insert(schema.issues)
      .values([
        {
          projectId: project.id,
          fingerprint: "legacy-silence",
          kind: "log" as const,
          exceptionType: "ExpectedProbe",
          title: "Expected probe",
          firstSeen: now,
          lastSeen: now,
        },
        {
          projectId: project.id,
          fingerprint: "legacy-observe",
          kind: "log" as const,
          exceptionType: "OneOff",
          title: "One-off error",
          firstSeen: now,
          lastSeen: now,
        },
        {
          projectId: project.id,
          fingerprint: "legacy-resolve",
          kind: "log" as const,
          exceptionType: "Recovered",
          title: "Recovered error",
          firstSeen: now,
          lastSeen: now,
        },
      ])
      .returning();
    const silenceIssue = issues[0];
    const observeIssue = issues[1];
    const resolvedIssue = issues[2];
    assert.ok(silenceIssue && observeIssue && resolvedIssue);
    await db
      .insert(schema.incidentIssues)
      .values(issues.map((issue) => ({ incidentId: incident.id, issueId: issue.id })));
    const run = one(
      await db
        .insert(schema.agentRuns)
        .values({ incidentId: incident.id, runtime: "test", state: "running" })
        .returning(),
    );

    await classifyIncidentIssue(db, {
      incidentId: incident.id,
      issueId: silenceIssue.id,
      agentRunId: run.id,
      action: { kind: "silence" },
      reason: "Expected probe traffic.",
      evidence: "The handler returned its documented no-op response.",
      now,
    });
    await classifyIncidentIssue(db, {
      incidentId: incident.id,
      issueId: observeIssue.id,
      agentRunId: run.id,
      action: { kind: "observe", trigger: { kind: "count", count: 25 } },
      reason: "A one-off worth watching.",
      evidence: "Only one occurrence was observed.",
      now: new Date(now.getTime() + 1_000),
    });
    await classifyIncidentIssue(db, {
      incidentId: incident.id,
      issueId: resolvedIssue.id,
      agentRunId: run.id,
      action: { kind: "resolve" },
      reason: "The transient condition recovered.",
      evidence: "The error remained absent for 30 minutes.",
      now: new Date(now.getTime() + 2_000),
    });

    const synthesized = await synthesizeLegacyIncidentIssueOutcomes(db, {
      incidentId: incident.id,
      agentRunId: run.id,
    });

    assert.equal(synthesized.ok, true);
    if (!synthesized.ok) return;
    const expected: schema.AgentRunIssueClassification[] = [
      {
        issueId: silenceIssue.id,
        action: "silence",
        reason: "Expected probe traffic.",
        evidence: "The handler returned its documented no-op response.",
      },
      {
        issueId: observeIssue.id,
        action: "observe",
        reason: "A one-off worth watching.",
        evidence: "Only one occurrence was observed.",
        trigger: { kind: "count", count: 25 },
      },
      {
        issueId: resolvedIssue.id,
        action: "resolve",
        reason: "The transient condition recovered.",
        evidence: "The error remained absent for 30 minutes.",
      },
    ];
    assert.deepEqual(
      [...synthesized.outcomes].sort((a, b) => a.issueId.localeCompare(b.issueId)),
      expected.sort((a, b) => a.issueId.localeCompare(b.issueId)),
    );
  } finally {
    await client.close();
  }
});

test("a legacy issue action cannot classify through a closed Incident aggregate", async () => {
  const { db, client } = await freshDb();
  try {
    const org = one(
      await db.insert(schema.orgs).values({ name: "Acme", slug: "acme-closed" }).returning(),
    );
    const project = one(
      await db
        .insert(schema.projects)
        .values({ orgId: org.id, name: "P", slug: "p-closed" })
        .returning(),
    );
    const now = new Date("2026-07-14T12:00:00.000Z");
    const incident = one(
      await db
        .insert(schema.incidents)
        .values({
          projectId: project.id,
          title: "Already resolved checkout failure",
          codename: "closed-legacy-action",
          status: "resolved",
          firstSeen: now,
          lastSeen: now,
          resolvedAt: now,
          resolvedByKind: "dashboard_manual",
          resolvedReasonCode: "problem_resolved",
        })
        .returning(),
    );
    const issue = one(
      await db
        .insert(schema.issues)
        .values({
          projectId: project.id,
          fingerprint: "late-legacy-classification",
          kind: "log",
          exceptionType: "LateLegacyAction",
          title: "Late legacy action",
          firstSeen: now,
          lastSeen: now,
        })
        .returning(),
    );
    await db.insert(schema.incidentIssues).values({ incidentId: incident.id, issueId: issue.id });

    const result = await classifyIncidentIssue(db, {
      incidentId: incident.id,
      issueId: issue.id,
      action: { kind: "silence" },
      reason: "The old session called its retired classification tool late.",
      evidence: "The Incident was already resolved before this call arrived.",
      now: new Date(now.getTime() + 1_000),
    });

    assert.deepEqual(result, {
      ok: false,
      error: "incident_not_open",
      message: "This Incident is no longer open, so its Issues cannot be classified from this run.",
    });
    const issueAfter = one(
      await db.select().from(schema.issues).where(eq(schema.issues.id, issue.id)),
    );
    assert.equal(issueAfter.status, "open");
    const classificationEvents = await db.query.incidentEvents.findMany({
      where: eq(schema.incidentEvents.incidentId, incident.id),
    });
    assert.equal(classificationEvents.length, 0);
  } finally {
    await client.close();
  }
});
