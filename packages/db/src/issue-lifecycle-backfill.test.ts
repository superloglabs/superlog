import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "./schema.js";

// The 0081 data migration backfills issues.status, collapses duplicate
// (project_id, fingerprint) rows created by the old silence semantics, and
// retires the incident 'autoresolved_noise' status; 0082 then adds the full
// unique fingerprint index that depends on the dedupe. This test replays the
// real ledger up to just before 0081, seeds fixtures shaped like the prod data
// (silenced duplicates, noise incidents, resolved incidents), then applies the
// rest of the ledger and asserts the outcome.

function one<T>(rows: T[]): T {
  const row = rows[0];
  assert.ok(row, "expected a row");
  return row;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(HERE, "../migrations");
const CUTOFF_TAG = "0081_issue_lifecycle_backfill";

// Fixture inserts use raw SQL rather than the drizzle schema: the seeding
// happens against the historical schema (just before the backfill), while
// schema.ts describes the current one — later migrations add columns that a
// schema-driven INSERT would reference before they exist.
type RawDb = { query: unknown } & {
  execute(q: unknown): Promise<unknown>;
};

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

async function insertIssueRaw(
  db: RawDb,
  values: {
    projectId: string;
    fingerprint: string;
    firstSeen: Date;
    lastSeen: Date;
    silencedAt?: Date | null;
    eventCount?: number;
  },
): Promise<{ id: string }> {
  const result = await db.execute(sql`
    INSERT INTO issues (project_id, fingerprint, kind, exception_type, title,
                        first_seen, last_seen, silenced_at, event_count)
    VALUES (${values.projectId}, ${values.fingerprint}, 'log', 'Error', 'boom',
            ${values.firstSeen.toISOString()}::timestamptz,
            ${values.lastSeen.toISOString()}::timestamptz,
            ${values.silencedAt ? values.silencedAt.toISOString() : null}::timestamptz,
            ${values.eventCount ?? 1})
    RETURNING id
  `);
  return one(rowsOf<{ id: string }>(result));
}

async function insertIncidentRaw(
  db: RawDb,
  values: {
    projectId: string;
    title: string;
    status: string;
    firstSeen: Date;
    lastSeen: Date;
    noiseReason?: string | null;
    noiseResolvedAt?: Date | null;
    noiseClassification?: Record<string, unknown> | null;
    resolvedAt?: Date | null;
    resolvedByKind?: string | null;
  },
): Promise<{ id: string }> {
  const result = await db.execute(sql`
    INSERT INTO incidents (project_id, title, status, first_seen, last_seen,
                           noise_reason, noise_resolved_at, noise_classification,
                           resolved_at, resolved_by_kind)
    VALUES (${values.projectId}, ${values.title}, ${values.status},
            ${values.firstSeen.toISOString()}::timestamptz,
            ${values.lastSeen.toISOString()}::timestamptz,
            ${values.noiseReason ?? null},
            ${values.noiseResolvedAt ? values.noiseResolvedAt.toISOString() : null}::timestamptz,
            ${values.noiseClassification ? JSON.stringify(values.noiseClassification) : null}::jsonb,
            ${values.resolvedAt ? values.resolvedAt.toISOString() : null}::timestamptz,
            ${values.resolvedByKind ?? null})
    RETURNING id
  `);
  return one(rowsOf<{ id: string }>(result));
}

async function linkRaw(db: RawDb, incidentId: string, issueId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO incident_issues (incident_id, issue_id) VALUES (${incidentId}, ${issueId})
  `);
}

function migrationsFolderBefore(tag: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "superlog-migrations-"));
  cpSync(MIGRATIONS, dir, { recursive: true });
  const journalPath = path.join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.entries = journal.entries.filter((e: { tag: string }) => e.tag < tag);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

test("issue lifecycle backfill migrates prod-shaped data and the unique index lands", async () => {
  const partial = migrationsFolderBefore(CUTOFF_TAG);
  const client = new PGlite();
  try {
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: partial });

    // --- Fixtures at the pre-backfill schema ---
    const org = one(
      await db.insert(schema.orgs).values({ name: "Acme", slug: "acme" }).returning(),
    );
    const project = one(
      await db
        .insert(schema.projects)
        .values({ orgId: org.id, name: "Default", slug: "default" })
        .returning(),
    );
    const now = new Date("2026-07-01T00:00:00Z");
    const earlier = new Date("2026-06-01T00:00:00Z");

    // Duplicate-fingerprint group: two silenced generations + one active row
    // (the shape the old partial unique index produced on prod).
    const dupOld = await insertIssueRaw(db, {
      projectId: project.id,
      fingerprint: "fp-dup",
      firstSeen: earlier,
      lastSeen: earlier,
      silencedAt: earlier,
      eventCount: 10,
    });
    const dupMid = await insertIssueRaw(db, {
      projectId: project.id,
      fingerprint: "fp-dup",
      firstSeen: now,
      lastSeen: now,
      silencedAt: now,
      eventCount: 5,
    });
    const dupActive = await insertIssueRaw(db, {
      projectId: project.id,
      fingerprint: "fp-dup",
      firstSeen: now,
      lastSeen: now,
      eventCount: 2,
    });

    // Issue linked to a noise-closed incident.
    const noiseIssue = await insertIssueRaw(db, {
      projectId: project.id,
      fingerprint: "fp-noise",
      firstSeen: now,
      lastSeen: now,
      eventCount: 7,
    });
    const noiseIncident = await insertIncidentRaw(db, {
      projectId: project.id,
      title: "noise incident",
      status: "autoresolved_noise",
      noiseReason: "expected_third_party",
      noiseResolvedAt: earlier,
      noiseClassification: { reason: "expected_third_party", evidence: "third party flake" },
      firstSeen: earlier,
      lastSeen: now,
    });
    await linkRaw(db, noiseIncident.id, noiseIssue.id);

    // Issue linked to a resolved incident.
    const resolvedIssue = await insertIssueRaw(db, {
      projectId: project.id,
      fingerprint: "fp-resolved",
      firstSeen: now,
      lastSeen: now,
    });
    const resolvedIncident = await insertIncidentRaw(db, {
      projectId: project.id,
      title: "fixed incident",
      status: "resolved",
      resolvedAt: earlier,
      resolvedByKind: "agent_pr_merged",
      firstSeen: earlier,
      lastSeen: earlier,
    });
    await linkRaw(db, resolvedIncident.id, resolvedIssue.id);

    // Issue linked to an open incident, and an unlinked issue — both stay open.
    const openIssue = await insertIssueRaw(db, {
      projectId: project.id,
      fingerprint: "fp-open",
      firstSeen: now,
      lastSeen: now,
    });
    const openIncident = await insertIncidentRaw(db, {
      projectId: project.id,
      title: "live incident",
      status: "open",
      firstSeen: now,
      lastSeen: now,
    });
    await linkRaw(db, openIncident.id, openIssue.id);
    const unlinkedIssue = await insertIssueRaw(db, {
      projectId: project.id,
      fingerprint: "fp-unlinked",
      firstSeen: now,
      lastSeen: now,
    });

    // Loser duplicates carry incident links too: one to its own noise incident
    // (repointable) and one to an incident the survivor will also cover after
    // the survivor's own link is added (exercises the skip-then-cascade path).
    const dupIncident = await insertIncidentRaw(db, {
      projectId: project.id,
      title: "dup incident",
      status: "autoresolved_noise",
      noiseReason: "confusing_log_no_impact",
      noiseResolvedAt: earlier,
      firstSeen: earlier,
      lastSeen: earlier,
    });
    await linkRaw(db, dupIncident.id, dupOld.id);
    const sharedIncident = await insertIncidentRaw(db, {
      projectId: project.id,
      title: "shared incident",
      status: "open",
      firstSeen: now,
      lastSeen: now,
    });
    await linkRaw(db, sharedIncident.id, dupMid.id);
    await linkRaw(db, sharedIncident.id, dupActive.id);

    // --- Apply the backfill (0081) and the full unique index (0082+) ---
    await migrate(db, { migrationsFolder: MIGRATIONS });

    // Dedupe: only the active row survives, with folded counters.
    const dupRows = await db.query.issues.findMany({
      where: (issues, { eq: eqOp, and: andOp }) =>
        andOp(eqOp(issues.projectId, project.id), eqOp(issues.fingerprint, "fp-dup")),
    });
    assert.equal(dupRows.length, 1);
    const survivor = one(dupRows);
    assert.equal(survivor.id, dupActive.id);
    assert.equal(survivor.eventCount, 17);
    assert.equal(survivor.firstSeen.toISOString(), earlier.toISOString());
    // Survivor was the active row → stays open.
    assert.equal(survivor.status, "open");

    // The repointable loser link now points at the survivor; the shared
    // incident kept a single link to the survivor (duplicate cascaded away).
    const survivorLinks = await db.query.incidentIssues.findMany({
      where: (t, { eq: eqOp }) => eqOp(t.issueId, dupActive.id),
    });
    const linkedIncidentIds = survivorLinks.map((l) => l.incidentId).sort();
    assert.deepEqual(linkedIncidentIds, [dupIncident.id, sharedIncident.id].sort());

    // Status backfill.
    const byId = async (id: string) =>
      (await db.query.issues.findFirst({ where: (t, { eq: eqOp }) => eqOp(t.id, id) }))!;
    assert.equal((await byId(noiseIssue.id)).status, "silenced");
    assert.ok((await byId(noiseIssue.id)).silencedAt);
    assert.equal((await byId(resolvedIssue.id)).status, "resolved");
    assert.equal((await byId(openIssue.id)).status, "open");
    assert.equal((await byId(unlinkedIssue.id)).status, "open");

    // Noise incidents converted to resolved with carried-over metadata.
    const convertedNoise = (await db.query.incidents.findFirst({
      where: (t, { eq: eqOp }) => eqOp(t.id, noiseIncident.id),
    }))!;
    assert.equal(convertedNoise.status, "resolved");
    assert.equal(convertedNoise.resolvedByKind, "agent_classification");
    assert.equal(convertedNoise.resolvedReasonCode, "expected_third_party");
    assert.equal(convertedNoise.resolvedReasonText, "third party flake");
    assert.equal(convertedNoise.resolvedAt?.toISOString(), earlier.toISOString());
    // Pre-existing resolved incidents untouched.
    const untouched = (await db.query.incidents.findFirst({
      where: (t, { eq: eqOp }) => eqOp(t.id, resolvedIncident.id),
    }))!;
    assert.equal(untouched.resolvedByKind, "agent_pr_merged");

    // The full unique index is live: a second active row for an existing
    // fingerprint (silenced or not) must now be rejected.
    let uniqueViolation: unknown = null;
    try {
      await db.insert(schema.issues).values({
        projectId: project.id,
        kind: "log",
        exceptionType: "Error",
        title: "boom",
        firstSeen: now,
        lastSeen: now,
        fingerprint: "fp-noise",
      });
    } catch (err) {
      uniqueViolation = err;
    }
    assert.ok(uniqueViolation, "duplicate fingerprint insert should be rejected");
    const violationText = `${uniqueViolation} ${(uniqueViolation as { cause?: unknown }).cause ?? ""}`;
    assert.match(violationText, /duplicate key|unique/i);
  } finally {
    await client.close();
    rmSync(partial, { recursive: true, force: true });
  }
});
