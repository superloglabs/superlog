// Backfills `slack_installations.channel_id` / `channel_name` from the
// `project_slack_routes` table that we're folding away. Each route has a
// (project_id, installation_id) pair pointing at a channel — copy the channel
// onto the install row. Idempotent.
//
// Run against prod via Railway:
//   railway run --service Postgres bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" pnpm tsx scripts/backfill-slack-channel-onto-install.ts'
import process from "node:process";
import { sql } from "drizzle-orm";

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }

  const [{ db }] = await Promise.all([import("../packages/db/src/client.js")]);

  // Only update where the install's channel cols aren't already populated, so
  // re-runs don't clobber values that the new code path has since written.
  const result = await db.execute(sql`
    UPDATE slack_installations si
       SET channel_id = psr.channel_id,
           channel_name = psr.channel_name
      FROM project_slack_routes psr
     WHERE psr.installation_id = si.id
       AND si.channel_id IS NULL
  `);

  // postgres-js returns the row count via `count`.
  const rowsAffected =
    (result as unknown as { count?: number }).count ??
    (result as unknown as { rowCount?: number }).rowCount ??
    "?";
  console.log(`backfilled channel onto slack_installations: rows=${rowsAffected}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
