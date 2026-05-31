// Backfills `codename` for incidents that were created before the codename
// column existed. Safe to run multiple times — only touches rows where the
// codename is empty.
//
// Usage:
//   pnpm tsx scripts/backfill-incident-codenames.ts --dry-run
//   pnpm tsx scripts/backfill-incident-codenames.ts --apply
//
// Against prod, run via Railway so the DATABASE_URL comes from there:
//   railway run --service api pnpm tsx scripts/backfill-incident-codenames.ts --dry-run
//   railway run --service api pnpm tsx scripts/backfill-incident-codenames.ts --apply
import process from "node:process";
import { and, eq } from "drizzle-orm";

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }
  const apply = process.argv.includes("--apply");
  const dry = process.argv.includes("--dry-run") || !apply;

  const [{ db }, schema, { generateCodename }] = await Promise.all([
    import("../packages/db/src/client.js"),
    import("../packages/db/src/schema.js"),
    import("../packages/db/src/codename.js"),
  ]);

  const stale = await db.query.incidents.findMany({
    where: eq(schema.incidents.codename, ""),
    columns: { id: true, projectId: true, title: true },
  });
  console.log(`${dry ? "DRY RUN" : "APPLIED"}: ${stale.length} incident(s) need codenames`);
  if (stale.length === 0) return;

  let fixed = 0;
  for (const row of stale) {
    let assigned: string | null = null;
    for (let attempt = 0; attempt < 8 && !assigned; attempt++) {
      const candidate = generateCodename();
      if (dry) {
        // Preview only — assume the candidate is unique.
        assigned = candidate;
        break;
      }
      try {
        const r = await db
          .update(schema.incidents)
          .set({ codename: candidate, updatedAt: new Date() })
          .where(and(eq(schema.incidents.id, row.id), eq(schema.incidents.codename, "")))
          .returning({ id: schema.incidents.id });
        if (r[0]) {
          assigned = candidate;
        } else {
          // Concurrent run already filled it — nothing to do.
          assigned = "(already set by another run)";
        }
      } catch (err) {
        const code = (err as { code?: string } | null)?.code;
        if (code !== "23505") throw err; // unique_violation → retry with another name
      }
    }
    if (assigned) {
      fixed += 1;
      console.log(`  ${row.id} → ${assigned}  (${row.title.slice(0, 60)})`);
    } else {
      console.warn(`  ${row.id} — failed to allocate codename after 8 attempts`);
    }
  }
  console.log(`\n${dry ? "DRY RUN" : "APPLIED"}: ${fixed}/${stale.length} updated.`);
  if (dry) console.log("Re-run with --apply to write the changes.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
