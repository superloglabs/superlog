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

// resolve-incident.js transitively imports ./client.js, which throws at import
// time without a connection string. postgres-js connects lazily and every test
// here passes an explicit pglite DB, so a dummy value is enough.
process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";
const { createIncidentLifecycle } = await import("./resolve-incident.js");

// End-to-end lifecycle semantics on a real (in-process) Postgres:
//   - resolveIncident cascades the issue disposition (resolve / silence /
//     observe) to the issues whose current incident is the one closing, and
//     records an incident event per transition.
//   - openRecurrence starts a NEW incident chained to the predecessor, flips
//     the issue back to open, and appends (not repoints) the issue link.

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

async function seedIncidentWithIssue(
  db: DB,
  projectId: string,
  opts: { fingerprint: string; eventCount?: number },
) {
  const now = new Date();
  const issue = one(
    await db
      .insert(schema.issues)
      .values({
        projectId,
        fingerprint: opts.fingerprint,
        kind: "log",
        exceptionType: "Error",
        title: `boom ${opts.fingerprint}`,
        firstSeen: now,
        lastSeen: now,
        eventCount: opts.eventCount ?? 1,
      })
      .returning(),
  );
  const incident = one(
    await db
      .insert(schema.incidents)
      .values({
        projectId,
        title: issue.title,
        codename: `cn-${opts.fingerprint}`,
        status: "open",
        firstSeen: now,
        lastSeen: now,
      })
      .returning(),
  );
  await db.insert(schema.incidentIssues).values({ incidentId: incident.id, issueId: issue.id });
  return { issue, incident };
}

async function eventKinds(db: DB, incidentId: string): Promise<string[]> {
  const rows = await db.query.incidentEvents.findMany({
    where: eq(schema.incidentEvents.incidentId, incidentId),
  });
  return rows.map((r) => r.kind).sort();
}

test("resolve with default outcome marks current issues resolved", async () => {
  const { db, client } = await freshDb();
  try {
    const project = await seedProject(db);
    const { issue, incident } = await seedIncidentWithIssue(db, project.id, {
      fingerprint: "fp-1",
    });
    const result = await createIncidentLifecycle(db).resolve({
      incidentId: incident.id,
      kind: "dashboard_manual",
      reasonCode: "problem_resolved",
      reasonText: null,
    });
    assert.equal(result.resolved, true);
    assert.equal(result.resolvedIssueCount, 1);

    const after = one(await db.select().from(schema.issues).where(eq(schema.issues.id, issue.id)));
    assert.equal(after.status, "resolved");
    const kinds = await eventKinds(db, incident.id);
    assert.ok(kinds.includes("incident_resolved"));
    assert.ok(kinds.includes("issue_resolved"));
  } finally {
    await client.close();
  }
});

test("resolve with silence outcome silences current issues", async () => {
  const { db, client } = await freshDb();
  try {
    const project = await seedProject(db);
    const { issue, incident } = await seedIncidentWithIssue(db, project.id, {
      fingerprint: "fp-2",
    });
    await createIncidentLifecycle(db).resolve({
      incidentId: incident.id,
      kind: "dashboard_manual",
      reasonCode: "not_an_issue",
      reasonText: null,
      issueOutcome: { kind: "silence" },
    });
    const after = one(await db.select().from(schema.issues).where(eq(schema.issues.id, issue.id)));
    assert.equal(after.status, "silenced");
    assert.ok(after.silencedAt);
    assert.ok((await eventKinds(db, incident.id)).includes("issue_silenced"));
  } finally {
    await client.close();
  }
});

test("resolve with observe outcome stores the trigger and baseline", async () => {
  const { db, client } = await freshDb();
  try {
    const project = await seedProject(db);
    const { issue, incident } = await seedIncidentWithIssue(db, project.id, {
      fingerprint: "fp-3",
      eventCount: 42,
    });
    await createIncidentLifecycle(db).resolve({
      incidentId: incident.id,
      kind: "agent_classification",
      reasonCode: "expected_third_party",
      reasonText: "flaky upstream",
      issueOutcome: { kind: "observe", trigger: { kind: "count", count: 100 } },
    });
    const after = one(await db.select().from(schema.issues).where(eq(schema.issues.id, issue.id)));
    assert.equal(after.status, "under_observation");
    assert.deepEqual(after.escalationTrigger, { kind: "count", count: 100 });
    assert.equal(after.observationBaselineEventCount, 42);
    assert.ok(after.observationStartedAt);
    assert.ok((await eventKinds(db, incident.id)).includes("issue_observed"));
  } finally {
    await client.close();
  }
});

test("resolving an old incident does not touch issues that recurred into a newer one", async () => {
  const { db, client } = await freshDb();
  try {
    const project = await seedProject(db);
    const { issue, incident } = await seedIncidentWithIssue(db, project.id, {
      fingerprint: "fp-4",
    });
    // Simulate a recurrence: issue got linked to a newer incident later.
    const newer = one(
      await db
        .insert(schema.incidents)
        .values({
          projectId: project.id,
          title: issue.title,
          codename: "cn-newer",
          status: "open",
          firstSeen: new Date(),
          lastSeen: new Date(),
          previousIncidentId: incident.id,
        })
        .returning(),
    );
    await db.insert(schema.incidentIssues).values({
      incidentId: newer.id,
      issueId: issue.id,
      createdAt: new Date(Date.now() + 1000),
    });

    const result = await createIncidentLifecycle(db).resolve({
      incidentId: incident.id,
      kind: "dashboard_manual",
      reasonCode: "problem_resolved",
      reasonText: null,
    });
    assert.equal(result.resolved, true);
    assert.equal(result.resolvedIssueCount, 0);
    const after = one(await db.select().from(schema.issues).where(eq(schema.issues.id, issue.id)));
    assert.equal(after.status, "open");
  } finally {
    await client.close();
  }
});

test("openRecurrence chains a new incident, reopens the issue, and appends the link", async () => {
  const { db, client } = await freshDb();
  try {
    const project = await seedProject(db);
    const { issue, incident } = await seedIncidentWithIssue(db, project.id, {
      fingerprint: "fp-5",
    });
    const lifecycle = createIncidentLifecycle(db);
    await lifecycle.resolve({
      incidentId: incident.id,
      kind: "dashboard_manual",
      reasonCode: "problem_resolved",
      reasonText: null,
    });
    const resolvedIssue = one(
      await db.select().from(schema.issues).where(eq(schema.issues.id, issue.id)),
    );
    assert.equal(resolvedIssue.status, "resolved");

    const recurrence = await lifecycle.openRecurrence({
      previousIncident: incident,
      issue: resolvedIssue,
      origin: "resolved_issue_recurred",
    });
    assert.notEqual(recurrence.id, incident.id);
    assert.equal(recurrence.status, "open");
    assert.equal(recurrence.previousIncidentId, incident.id);

    const after = one(await db.select().from(schema.issues).where(eq(schema.issues.id, issue.id)));
    assert.equal(after.status, "open");
    assert.equal(after.silencedAt, null);

    const links = await db.query.incidentIssues.findMany({
      where: eq(schema.incidentIssues.issueId, issue.id),
    });
    assert.equal(links.length, 2);

    const newKinds = await eventKinds(db, recurrence.id);
    assert.ok(newKinds.includes("incident_opened_from_recurrence"));
    assert.ok(newKinds.includes("issue_reopened"));
    const oldKinds = await eventKinds(db, incident.id);
    assert.ok(oldKinds.includes("issue_recurred"));
  } finally {
    await client.close();
  }
});
