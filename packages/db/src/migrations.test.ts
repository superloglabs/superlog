import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "./schema.js";

// Applies the entire committed migration ledger against an in-process Postgres
// (pglite) and asserts the resulting schema is usable. The ledger is keyed by
// SHA-256 of each SQL file and has bricked prod before when edited by hand
// (see CLAUDE.md), so a clean full-replay guard is cheap insurance: it fails
// fast in CI if a generated migration is malformed or the chain drifts.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(HERE, "../migrations");

test("the full migration ledger applies cleanly and yields a usable schema", async () => {
  const client = new PGlite();
  try {
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS });

    // A handful of core tables across migration eras must exist and be queryable.
    for (const table of [
      schema.orgs,
      schema.projects,
      schema.incidents,
      schema.issues,
      schema.incidentResolutionProposals,
    ]) {
      const rows = await db.select().from(table).limit(0);
      assert.deepEqual(rows, []);
    }

    // The latest migration's column is present.
    const cols = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'incidents' AND column_name = 'autorecovery_last_evaluated_at'
    `);
    assert.equal(cols.rows.length, 1, "0053 column should exist after replay");
  } finally {
    await client.close();
  }
});
