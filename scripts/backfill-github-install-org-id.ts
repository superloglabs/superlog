// Backfills `github_installations.org_id` for existing project-scoped rows
// by reading the owning project's org_id. Org-scoped rows (project_id NULL)
// don't exist yet — those start landing once PR6b's management API ships.
//
// Run against prod via Railway:
//   railway run --service Postgres bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" pnpm tsx scripts/backfill-github-install-org-id.ts'
//
// Idempotent: only updates rows where org_id IS NULL.
import process from "node:process";
import { sql } from "drizzle-orm";

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

  const [{ db }] = await Promise.all([import("../packages/db/src/client.js")]);

  const result = await db.execute(sql`
    UPDATE github_installations gi
       SET org_id = p.org_id
      FROM projects p
     WHERE p.id = gi.project_id
       AND gi.org_id IS NULL
  `);

  const rows =
    (result as unknown as { count?: number }).count ??
    (result as unknown as { rowCount?: number }).rowCount ??
    "?";
  console.log(`backfilled github_installations.org_id: rows=${rows}`);

  // Sanity: report any rows still missing org_id (would be either orphan rows
  // with no matching project, or new org-scoped rows that PR6b will introduce).
  const stillNull = await db.execute<{ count: number }>(sql`
    SELECT COUNT(*)::int AS count FROM github_installations WHERE org_id IS NULL
  `);
  const remaining = (stillNull as unknown as Array<{ count: number }>)[0]?.count ?? 0;
  console.log(`remaining rows with NULL org_id: ${remaining}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
