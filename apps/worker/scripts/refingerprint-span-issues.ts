// One-off backfill: re-fingerprint every kind=span issue using the new
// fingerprint() (which now includes the normalized error message in the hash).
// Iterates issues, recomputes the hash from last_sample, then applies an UPDATE
// per row. Collisions with an existing live issue on (project_id, new_hash)
// are resolved by merging into the older row and repointing incident_issues.
//
// Usage:
//   pnpm tsx scripts/refingerprint-span-issues.ts            # dry-run, prints stats
//   pnpm tsx scripts/refingerprint-span-issues.ts --apply    # mutate
//   pnpm tsx scripts/refingerprint-span-issues.ts --apply --project-id <uuid>
//
// Against prod, wrap with `railway run --service worker`.
import "../src/env.js";
import { db, schema } from "@superlog/db";
import { fingerprint } from "@superlog/fingerprint";
import { and, eq, sql } from "drizzle-orm";

type Args = { apply: boolean; projectId: string | null };

function parseArgs(argv: string[]): Args {
  const apply = argv.includes("--apply");
  const idx = argv.indexOf("--project-id");
  const projectId = idx >= 0 ? argv[idx + 1] ?? null : null;
  return { apply, projectId };
}

type Sample = {
  stacktrace?: string | null;
  message?: string | null;
  exceptionType?: string | null;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`mode: ${args.apply ? "APPLY" : "dry-run"}`);
  if (args.projectId) console.log(`scope: project_id=${args.projectId}`);

  const rows = await db
    .select({
      id: schema.issues.id,
      projectId: schema.issues.projectId,
      fingerprint: schema.issues.fingerprint,
      exceptionType: schema.issues.exceptionType,
      firstSeen: schema.issues.firstSeen,
      lastSeen: schema.issues.lastSeen,
      eventCount: schema.issues.eventCount,
      silencedAt: schema.issues.silencedAt,
      lastSample: schema.issues.lastSample,
    })
    .from(schema.issues)
    .where(
      args.projectId
        ? and(eq(schema.issues.kind, "span"), eq(schema.issues.projectId, args.projectId))
        : eq(schema.issues.kind, "span"),
    );

  console.log(`scanned ${rows.length} span issues`);

  let unchanged = 0;
  let noSample = 0;
  let wouldChange = 0;
  let wouldCollide = 0;
  let merged = 0;
  let updated = 0;

  for (const row of rows) {
    const sample = (row.lastSample ?? null) as Sample | null;
    if (!sample || !sample.stacktrace) {
      noSample += 1;
      continue;
    }
    const next = fingerprint({
      type: sample.exceptionType ?? row.exceptionType ?? "Error",
      stacktrace: sample.stacktrace,
      message: sample.message ?? null,
    });
    if (next.hash === row.fingerprint) {
      unchanged += 1;
      continue;
    }

    // Look for a live sibling that would collide on the partial unique index.
    // (silenced rows don't participate, mirroring issues_project_fingerprint_idx.)
    const collision = await db
      .select({ id: schema.issues.id, firstSeen: schema.issues.firstSeen })
      .from(schema.issues)
      .where(
        and(
          eq(schema.issues.projectId, row.projectId),
          eq(schema.issues.fingerprint, next.hash),
          sql`silenced_at IS NULL`,
        ),
      )
      .limit(1);

    if (collision[0] && collision[0].id !== row.id && !row.silencedAt) {
      wouldCollide += 1;
      if (!args.apply) continue;
      // Merge into the older row (smaller first_seen).
      const survivor =
        collision[0].firstSeen.getTime() <= row.firstSeen.getTime() ? collision[0].id : row.id;
      const loser = survivor === collision[0].id ? row.id : collision[0].id;
      await db.transaction(async (tx) => {
        // Pull the loser's counters before deletion.
        const [loserRow] = await tx
          .select({
            firstSeen: schema.issues.firstSeen,
            lastSeen: schema.issues.lastSeen,
            eventCount: schema.issues.eventCount,
            lastSample: schema.issues.lastSample,
            message: schema.issues.message,
            normalizedFrames: schema.issues.normalizedFrames,
            topFrame: schema.issues.topFrame,
          })
          .from(schema.issues)
          .where(eq(schema.issues.id, loser));
        if (!loserRow) return;
        // Merge counters + take whichever last_sample is newer.
        await tx.execute(sql`
          UPDATE issues SET
            first_seen = LEAST(first_seen, ${loserRow.firstSeen.toISOString()}::timestamptz),
            last_seen = GREATEST(last_seen, ${loserRow.lastSeen.toISOString()}::timestamptz),
            event_count = event_count + ${loserRow.eventCount},
            last_sample = CASE
              WHEN last_seen >= ${loserRow.lastSeen.toISOString()}::timestamptz THEN last_sample
              ELSE ${JSON.stringify(loserRow.lastSample)}::jsonb
            END,
            top_frame = COALESCE(top_frame, ${loserRow.topFrame}),
            normalized_frames = CASE
              WHEN last_seen >= ${loserRow.lastSeen.toISOString()}::timestamptz THEN normalized_frames
              ELSE ${JSON.stringify(loserRow.normalizedFrames)}::jsonb
            END
          WHERE id = ${survivor}
        `);
        // Repoint incident_issues from loser → survivor; drop duplicates.
        await tx.execute(sql`
          UPDATE incident_issues SET issue_id = ${survivor}
          WHERE issue_id = ${loser}
          AND NOT EXISTS (
            SELECT 1 FROM incident_issues x
            WHERE x.issue_id = ${survivor} AND x.incident_id = incident_issues.incident_id
          )
        `);
        await tx.execute(sql`DELETE FROM incident_issues WHERE issue_id = ${loser}`);
        // The unique index on (project_id, fingerprint) WHERE silenced_at IS NULL
        // also forbids the loser holding the same hash live. Silence then delete.
        await tx.execute(sql`DELETE FROM issues WHERE id = ${loser}`);
      });
      merged += 1;
      continue;
    }

    wouldChange += 1;
    if (!args.apply) continue;
    await db
      .update(schema.issues)
      .set({
        fingerprint: next.hash,
        topFrame: next.topFrame,
        normalizedFrames: next.normalizedFrames,
      })
      .where(eq(schema.issues.id, row.id));
    updated += 1;
  }

  console.log("---");
  console.log(`unchanged:     ${unchanged}`);
  console.log(`no_sample:     ${noSample}`);
  if (args.apply) {
    console.log(`updated:       ${updated}`);
    console.log(`merged:        ${merged}`);
  } else {
    console.log(`would_change:  ${wouldChange}`);
    console.log(`would_collide: ${wouldCollide} (would be merged)`);
    console.log("rerun with --apply to mutate");
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
