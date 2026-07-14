import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readMigrationFiles, type MigrationMeta } from "drizzle-orm/migrator";
import postgres from "postgres";

// Arbitrary app-wide constant. Any process holding this advisory lock is the
// one currently running migrations; other replicas wait here instead of
// racing to apply the same migrations twice.
const MIGRATION_LOCK_KEY = 0x7091b001;

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");

export type AppliedMigration = {
  hash: string;
  createdAt: number;
};

export function planPendingMigrations(
  migrations: readonly MigrationMeta[],
  appliedMigrations: readonly AppliedMigration[],
): MigrationMeta[] {
  const latestAppliedAt = appliedMigrations.reduce(
    (latest, migration) => Math.max(latest, migration.createdAt),
    Number.NEGATIVE_INFINITY,
  );
  const appliedHashes = new Set(appliedMigrations.map((migration) => migration.hash));

  // Drizzle's Postgres migrator normally uses only the latest journal
  // timestamp as a watermark. Keep that behavior for historical files, but
  // also honor hashes already present in the ledger so rebasing an identical
  // generated migration cannot execute the same DDL twice.
  return migrations.filter(
    (migration) =>
      migration.folderMillis > latestAppliedAt && !appliedHashes.has(migration.hash),
  );
}

// How the migration client connects. Two shapes:
//   - "url": a full DATABASE_URL connection string (local dev, worktrees, the
//     long-running app tasks that connect as the DML-only `superlog_app` role).
//   - "env": no DATABASE_URL — fall back to the standard libpq PG* environment
//     variables (PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE/PGSSLMODE). Managed
//     deployments can use this so schema-owner credentials are injected without
//     flattening them into a hand-maintained DATABASE_URL that drifts on rotation.
export type MigrationConnection =
  | { kind: "url"; connectionString: string }
  | { kind: "env"; ssl: "require" | undefined };

export function resolveMigrationConnection(env: NodeJS.ProcessEnv): MigrationConnection {
  if (env.DATABASE_URL) {
    return { kind: "url", connectionString: env.DATABASE_URL };
  }
  if (!env.PGHOST) {
    throw new Error(
      "No database connection configured: set DATABASE_URL or the libpq PGHOST/PGUSER/... env vars",
    );
  }
  // libpq treats sslmode=disable as "no TLS"; anything else implies TLS.
  // Managed Postgres deployments often set PGSSLMODE=require explicitly.
  const ssl = env.PGSSLMODE && env.PGSSLMODE !== "disable" ? "require" : undefined;
  return { kind: "env", ssl };
}

function createMigrationClient(env: NodeJS.ProcessEnv): postgres.Sql {
  const conn = resolveMigrationConnection(env);
  // Dedicated single connection: advisory locks are session-scoped, so the
  // lock/unlock + migrations must all share one connection.
  if (conn.kind === "url") {
    return postgres(conn.connectionString, { prepare: false, max: 1 });
  }
  // postgres-js reads the remaining libpq vars (PGHOST/PGPORT/PGUSER/...) from
  // the environment when they aren't passed explicitly.
  return postgres({ prepare: false, max: 1, ssl: conn.ssl });
}

async function applyPendingMigrations(sql: postgres.Sql): Promise<void> {
  await sql`CREATE SCHEMA IF NOT EXISTS drizzle`;
  await sql`
    CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `;

  const appliedRows = await sql<Array<{ hash: string; created_at: string | number | null }>>`
    SELECT hash, created_at
    FROM drizzle.__drizzle_migrations
  `;
  const appliedMigrations = appliedRows.map((row) => ({
    hash: row.hash,
    createdAt: Number(row.created_at),
  }));
  const migrations = readMigrationFiles({ migrationsFolder: MIGRATIONS_DIR });
  const pendingMigrations = planPendingMigrations(migrations, appliedMigrations);

  await sql.begin(async (transaction) => {
    for (const migration of pendingMigrations) {
      for (const statement of migration.sql) {
        await transaction.unsafe(statement);
      }
      await transaction`
        INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
        VALUES (${migration.hash}, ${migration.folderMillis})
      `;
    }
  });
}

export async function runMigrations(): Promise<void> {
  const sql = createMigrationClient(process.env);
  try {
    await sql`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
    try {
      await applyPendingMigrations(sql);
    } finally {
      await sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
    }
  } finally {
    await sql.end();
  }
}
