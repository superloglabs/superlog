import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

// Arbitrary app-wide constant. Any process holding this advisory lock is the
// one currently running migrations; other replicas wait here instead of
// racing to apply the same migrations twice.
const MIGRATION_LOCK_KEY = 0x7091b001;

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");

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

export async function runMigrations(): Promise<void> {
  const sql = createMigrationClient(process.env);
  try {
    await sql`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
    try {
      await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_DIR });
    } finally {
      await sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
    }
  } finally {
    await sql.end();
  }
}
