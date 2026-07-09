import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { eq, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { DB } from "./client.js";
import * as schema from "./schema.js";

// The 0091 backfill splits old aggregate alert issues (one per alert+group,
// accumulating every breach) into per-episode issues (1:1 with
// alert_episodes). The migration itself runs on an empty database in fresh
// environments, so these tests seed OLD-model data on a fully-migrated
// database and re-apply the 0091 statements — the exact shape prod is in when
// the migration runs there. The ordering test at the bottom instead stops at
// 0090 (the last pre-episode-model migration), seeds, and applies 0091 + 0092 for real.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(HERE, "../migrations");
const BACKFILL_SQL = path.resolve(MIGRATIONS, "0091_alert-episode-issue-backfill.sql");

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

async function applyMigrationFile(client: PGlite, file: string): Promise<void> {
  const sql = await readFile(path.join(MIGRATIONS, file), "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    await client.exec(statement);
  }
}

async function applyBackfill(client: PGlite): Promise<void> {
  const sql = await readFile(BACKFILL_SQL, "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    await client.exec(statement);
  }
}

// A database migrated only through 0090 — the pre-episode-as-issue schema a
// live deployment is on when 0091/0092 arrive.
async function dbAtPreBackfill(): Promise<{ db: DB; client: PGlite }> {
  const client = new PGlite();
  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql") && f < "0091").sort();
  for (const file of files) {
    await applyMigrationFile(client, file);
  }
  const db = drizzle(client, { schema }) as unknown as DB;
  return { db, client };
}

async function seedBase(db: DB) {
  const org = one(await db.insert(schema.orgs).values({ name: "Acme", slug: "acme" }).returning());
  const project = one(
    await db.insert(schema.projects).values({ orgId: org.id, name: "P", slug: "p" }).returning(),
  );
  const user = one(
    await db
      .insert(schema.users)
      .values({ email: "t@t.test", name: "T" } as typeof schema.users.$inferInsert)
      .returning(),
  );
  const alert = one(
    await db
      .insert(schema.alerts)
      .values({
        projectId: project.id,
        name: "Dialtone — request failures",
        source: "logs",
        aggregation: "count",
        comparator: "gt",
        threshold: 10,
        createdBy: user.id,
      } as typeof schema.alerts.$inferInsert)
      .returning(),
  );
  return { project, alert, user };
}

async function seedAggregateIssueWithIncident(
  db: DB,
  projectId: string,
  alertId: string,
  opts: { status?: string; title?: string; firstSeen: Date; lastSeen: Date },
) {
  const issue = one(
    await db
      .insert(schema.issues)
      .values({
        projectId,
        fingerprint: `alert:${alertId}`,
        kind: "alert",
        exceptionType: "AlertFired",
        title: opts.title ?? "Dialtone — request failures > 10 (observed=15)",
        message: opts.title ?? "Dialtone — request failures > 10 (observed=15)",
        firstSeen: opts.firstSeen,
        lastSeen: opts.lastSeen,
        eventCount: 7,
      })
      .returning(),
  );
  const incident = one(
    await db
      .insert(schema.incidents)
      .values({
        projectId,
        title: issue.title,
        codename: `cn-${Math.random().toString(36).slice(2, 8)}`,
        status: (opts.status ?? "resolved") as schema.IncidentStatus,
        firstSeen: opts.firstSeen,
        lastSeen: opts.lastSeen,
        issueCount: 1,
      })
      .returning(),
  );
  await db.insert(schema.incidentIssues).values({ incidentId: incident.id, issueId: issue.id });
  return { issue, incident };
}

test("backfill synthesizes a closed episode for a pre-episode alert incident and splits the issue", async () => {
  const { db, client } = await freshDb();
  try {
    const { project, alert } = await seedBase(db);
    const firstSeen = new Date("2026-05-01T10:00:00Z");
    const lastSeen = new Date("2026-05-01T10:20:00Z");
    const { issue: aggregate, incident } = await seedAggregateIssueWithIncident(
      db,
      project.id,
      alert.id,
      { firstSeen, lastSeen },
    );

    await applyBackfill(client);

    const episode = one(await db.select().from(schema.alertEpisodes));
    assert.equal(episode.alertId, alert.id);
    assert.equal(episode.state, "resolved");
    assert.equal(episode.startedAt.toISOString(), firstSeen.toISOString());
    assert.equal(episode.endedAt?.toISOString(), lastSeen.toISOString());
    // Parsed from "(observed=15)" in the title.
    assert.equal(episode.peakObservedValue, 15);
    assert.equal(episode.incidentId, incident.id);

    const episodeIssue = one(
      await db
        .select()
        .from(schema.issues)
        .where(eq(schema.issues.fingerprint, `alert-episode:${episode.id}`)),
    );
    assert.equal(episode.issueId, episodeIssue.id);
    assert.equal(episodeIssue.kind, "alert");
    assert.equal(episodeIssue.title, aggregate.title);
    // Incident is resolved → the historical episode issue is resolved.
    assert.equal(episodeIssue.status, "resolved");

    const links = await db
      .select()
      .from(schema.incidentIssues)
      .where(eq(schema.incidentIssues.incidentId, incident.id));
    assert.deepEqual(
      links.map((l) => l.issueId),
      [episodeIssue.id],
    );

    // The aggregate issue lost its only link and is gone.
    const aggregates = await db
      .select()
      .from(schema.issues)
      .where(like(schema.issues.fingerprint, "alert:%"));
    assert.equal(aggregates.length, 0);
  } finally {
    await client.close();
  }
});

test("backfill repoints an existing episode from the aggregate issue to its own issue", async () => {
  const { db, client } = await freshDb();
  try {
    const { project, alert } = await seedBase(db);
    const firstSeen = new Date("2026-06-01T09:00:00Z");
    const lastSeen = new Date("2026-06-01T09:05:00Z");
    const { issue: aggregate, incident } = await seedAggregateIssueWithIncident(
      db,
      project.id,
      alert.id,
      { status: "open", firstSeen, lastSeen },
    );
    const seeded = one(
      await db
        .insert(schema.alertEpisodes)
        .values({
          alertId: alert.id,
          projectId: project.id,
          groupKey: "",
          state: "firing",
          startedAt: firstSeen,
          openObservedValue: 12,
          peakObservedValue: 19,
          lastObservedValue: 14,
          lastFiringAt: lastSeen,
          issueId: aggregate.id,
          incidentId: incident.id,
        })
        .returning(),
    );

    await applyBackfill(client);

    const episode = one(await db.select().from(schema.alertEpisodes));
    assert.equal(episode.id, seeded.id);
    const episodeIssue = one(
      await db
        .select()
        .from(schema.issues)
        .where(eq(schema.issues.fingerprint, `alert-episode:${episode.id}`)),
    );
    assert.equal(episode.issueId, episodeIssue.id);
    // Open incident → the episode issue stays open.
    assert.equal(episodeIssue.status, "open");
    assert.equal(episodeIssue.title, aggregate.title);

    const links = await db
      .select()
      .from(schema.incidentIssues)
      .where(eq(schema.incidentIssues.incidentId, incident.id));
    assert.deepEqual(
      links.map((l) => l.issueId),
      [episodeIssue.id],
    );
    const aggregates = await db
      .select()
      .from(schema.issues)
      .where(like(schema.issues.fingerprint, "alert:%"));
    assert.equal(aggregates.length, 0);
  } finally {
    await client.close();
  }
});

test("backfill leaves aggregate issues alone when their alert is gone, and is idempotent", async () => {
  const { db, client } = await freshDb();
  try {
    const { project, alert } = await seedBase(db);
    const firstSeen = new Date("2026-04-01T08:00:00Z");
    const lastSeen = new Date("2026-04-01T08:10:00Z");
    const { issue: orphaned, incident: orphanedIncident } = await seedAggregateIssueWithIncident(
      db,
      project.id,
      alert.id,
      { firstSeen, lastSeen },
    );
    // Deleting the alert cascades its episodes but keeps the issue/incident;
    // there is nothing to synthesize a new episode against.
    await db.delete(schema.alerts).where(eq(schema.alerts.id, alert.id));

    await applyBackfill(client);
    await applyBackfill(client);

    const survivors = await db
      .select()
      .from(schema.issues)
      .where(like(schema.issues.fingerprint, "alert:%"));
    assert.deepEqual(
      survivors.map((issue) => issue.id),
      [orphaned.id],
    );
    const links = await db
      .select()
      .from(schema.incidentIssues)
      .where(eq(schema.incidentIssues.incidentId, orphanedIncident.id));
    assert.deepEqual(
      links.map((l) => l.issueId),
      [orphaned.id],
    );
    assert.equal((await db.select().from(schema.alertEpisodes)).length, 0);
  } finally {
    await client.close();
  }
});

test("0091 backfill runs before the 0092 unique index, so shared episode issue_ids don't break the deploy", async () => {
  const { db, client } = await dbAtPreBackfill();
  try {
    const { project, alert } = await seedBase(db);
    const firstSeen = new Date("2026-03-01T10:00:00Z");
    const { issue: aggregate, incident } = await seedAggregateIssueWithIncident(
      db,
      project.id,
      alert.id,
      { firstSeen, lastSeen: new Date("2026-03-01T10:30:00Z") },
    );
    // Two historical breaches of the same alert both point at the aggregate
    // issue — the pre-0091 shape that a unique index on issue_id would reject.
    for (const [start, end] of [
      ["2026-03-01T10:00:00Z", "2026-03-01T10:10:00Z"],
      ["2026-03-01T10:20:00Z", "2026-03-01T10:30:00Z"],
    ] as const) {
      await db.insert(schema.alertEpisodes).values({
        alertId: alert.id,
        projectId: project.id,
        groupKey: "",
        state: "resolved",
        startedAt: new Date(start),
        endedAt: new Date(end),
        openObservedValue: 12,
        peakObservedValue: 20,
        lastObservedValue: 12,
        lastFiringAt: new Date(end),
        issueId: aggregate.id,
        incidentId: incident.id,
      });
    }

    await applyMigrationFile(client, "0091_alert-episode-issue-backfill.sql");
    // The index build must succeed now that every episode has its own issue.
    await applyMigrationFile(client, "0092_harsh_trish_tilby.sql");

    const episodes = await db.select().from(schema.alertEpisodes);
    assert.equal(episodes.length, 2);
    const issueIds = new Set(episodes.map((e) => e.issueId));
    assert.equal(issueIds.size, 2);
    assert.ok(!issueIds.has(aggregate.id));
  } finally {
    await client.close();
  }
});
