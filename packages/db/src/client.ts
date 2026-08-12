import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

const client = postgres(connectionString, { prepare: false });
// Advisory locks that span provider calls use a separate pool. The guarded
// work may query through `db`, so sharing its pool would let lock waiters
// consume every connection and prevent the lock holder from completing.
const advisoryLockClient = postgres(connectionString, { prepare: false });

export const db = drizzle(client, { schema });
export type DB = typeof db;

export async function withDatabaseAdvisoryLocks<T>(
  keys: readonly string[],
  task: () => Promise<T>,
): Promise<T> {
  return advisoryLockClient.begin(async (transaction) => {
    for (const key of [...new Set(keys)].sort()) {
      await transaction`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    }
    return task();
  }) as Promise<T>;
}

export async function closeDb(): Promise<void> {
  await Promise.all([client.end({ timeout: 5 }), advisoryLockClient.end({ timeout: 5 })]);
}
