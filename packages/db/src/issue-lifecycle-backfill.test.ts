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
    const baseIssue = {
      projectId: project.id,
      kind: "log" as const,
      exceptionType: "Error",
      title: "boom",
      firstSeen: now,
      lastSeen: now,
    };

    // Duplicate-fingerprint group: two silenced generations + one active row
    // (the shape the old partial unique index produced on prod).
    const dupOld = one(
      await db
        .insert(schema.issues)
        .values({
          ...baseIssue,
          fingerprint: "fp-dup",
          firstSeen: earlier,
          lastSeen: earlier,
          silencedAt: earlier,
          eventCount: 10,
        })
        .returning(),
    );
    const dupMid = one(
      await db
        .insert(schema.issues)
        .values({ ...baseIssue, fingerprint: "fp-dup", silencedAt: now, eventCount: 5 })
        .returning(),
    );
    const dupActive = one(
      await db
        .insert(schema.issues)
        .values({ ...baseIssue, fingerprint: "fp-dup", eventCount: 2 })
        .returning(),
    );

    // Issue linked to a noise-closed incident.
    const noiseIssue = one(
      await db
        .insert(schema.issues)
        .values({ ...baseIssue, fingerprint: "fp-noise", eventCount: 7 })
        .returning(),
    );
    const noiseIncident = one(
      await db
        .insert(schema.incidents)
        .values({
          projectId: project.id,
          title: "noise incident",
          status: "autoresolved_noise",
          noiseReason: "expected_third_party",
          noiseResolvedAt: earlier,
          noiseClassification: { reason: "expected_third_party", evidence: "third party flake" },
          firstSeen: earlier,
          lastSeen: now,
        })
        .returning(),
    );
    await db
      .insert(schema.incidentIssues)
      .values({ incidentId: noiseIncident.id, issueId: noiseIssue.id });

    // Issue linked to a resolved incident.
    const resolvedIssue = one(
      await db
        .insert(schema.issues)
        .values({ ...baseIssue, fingerprint: "fp-resolved" })
        .returning(),
    );
    const resolvedIncident = one(
      await db
        .insert(schema.incidents)
        .values({
          projectId: project.id,
          title: "fixed incident",
          status: "resolved",
          resolvedAt: earlier,
          resolvedByKind: "agent_pr_merged",
          firstSeen: earlier,
          lastSeen: earlier,
        })
        .returning(),
    );
    await db
      .insert(schema.incidentIssues)
      .values({ incidentId: resolvedIncident.id, issueId: resolvedIssue.id });

    // Issue linked to an open incident, and an unlinked issue — both stay open.
    const openIssue = one(
      await db
        .insert(schema.issues)
        .values({ ...baseIssue, fingerprint: "fp-open" })
        .returning(),
    );
    const openIncident = one(
      await db
        .insert(schema.incidents)
        .values({
          projectId: project.id,
          title: "live incident",
          status: "open",
          firstSeen: now,
          lastSeen: now,
        })
        .returning(),
    );
    await db
      .insert(schema.incidentIssues)
      .values({ incidentId: openIncident.id, issueId: openIssue.id });
    const unlinkedIssue = one(
      await db
        .insert(schema.issues)
        .values({ ...baseIssue, fingerprint: "fp-unlinked" })
        .returning(),
    );

    // Loser duplicates carry incident links too: one to its own noise incident
    // (repointable) and one to an incident the survivor will also cover after
    // the survivor's own link is added (exercises the skip-then-cascade path).
    const dupIncident = one(
      await db
        .insert(schema.incidents)
        .values({
          projectId: project.id,
          title: "dup incident",
          status: "autoresolved_noise",
          noiseReason: "confusing_log_no_impact",
          noiseResolvedAt: earlier,
          firstSeen: earlier,
          lastSeen: earlier,
        })
        .returning(),
    );
    await db
      .insert(schema.incidentIssues)
      .values({ incidentId: dupIncident.id, issueId: dupOld.id });
    const sharedIncident = one(
      await db
        .insert(schema.incidents)
        .values({
          projectId: project.id,
          title: "shared incident",
          status: "open",
          firstSeen: now,
          lastSeen: now,
        })
        .returning(),
    );
    await db
      .insert(schema.incidentIssues)
      .values({ incidentId: sharedIncident.id, issueId: dupMid.id });
    await db
      .insert(schema.incidentIssues)
      .values({ incidentId: sharedIncident.id, issueId: dupActive.id });

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
      await db.insert(schema.issues).values({ ...baseIssue, fingerprint: "fp-noise" });
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
