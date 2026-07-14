import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { planPendingMigrations, resolveMigrationConnection } from "./migrate.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = readMigrationFiles({ migrationsFolder: path.resolve(HERE, "../migrations") });
const DEPLOYED_DIGEST_CREATED_AT = 1_784_031_056_182;
const TIDY_CREATED_AT = 1_784_031_696_429;
const REBASED_DIGEST_CREATED_AT = 1_784_032_979_583;

function migrationAt(createdAt: number) {
  const migration = MIGRATIONS.find((candidate) => candidate.folderMillis === createdAt);
  assert.ok(migration, `expected migration at ${createdAt}`);
  return migration;
}

test("resolveMigrationConnection prefers DATABASE_URL when set", () => {
  const out = resolveMigrationConnection({
    DATABASE_URL: "postgres://app:pw@localhost:5432/superlog",
    PGHOST: "ignored",
  } as NodeJS.ProcessEnv);
  assert.deepEqual(out, {
    kind: "url",
    connectionString: "postgres://app:pw@localhost:5432/superlog",
  });
});

test("resolveMigrationConnection falls back to libpq env when DATABASE_URL is absent", () => {
  const out = resolveMigrationConnection({
    PGHOST: "db.internal",
    PGUSER: "superlog",
    PGPASSWORD: "secret",
    PGSSLMODE: "require",
  } as NodeJS.ProcessEnv);
  assert.deepEqual(out, { kind: "env", ssl: "require" });
});

test("resolveMigrationConnection treats sslmode=disable as no TLS", () => {
  const out = resolveMigrationConnection({
    PGHOST: "localhost",
    PGSSLMODE: "disable",
  } as NodeJS.ProcessEnv);
  assert.deepEqual(out, { kind: "env", ssl: undefined });
});

test("resolveMigrationConnection defaults to no TLS when PGSSLMODE unset", () => {
  const out = resolveMigrationConnection({ PGHOST: "localhost" } as NodeJS.ProcessEnv);
  assert.deepEqual(out, { kind: "env", ssl: undefined });
});

test("resolveMigrationConnection throws when neither DATABASE_URL nor PGHOST is set", () => {
  assert.throws(
    () => resolveMigrationConnection({} as NodeJS.ProcessEnv),
    /No database connection configured/,
  );
});

test("pending migration planning skips SQL already applied under an earlier journal timestamp", () => {
  const deployedDigest = migrationAt(REBASED_DIGEST_CREATED_AT);
  const pendingTidy = migrationAt(TIDY_CREATED_AT);
  const laterMigrations = MIGRATIONS.filter(
    (migration) => migration.folderMillis > REBASED_DIGEST_CREATED_AT,
  );

  const pending = planPendingMigrations(MIGRATIONS, [
    {
      hash: deployedDigest.hash,
      createdAt: DEPLOYED_DIGEST_CREATED_AT,
    },
  ]);

  assert.deepEqual(
    pending.map((migration) => migration.hash),
    [pendingTidy.hash, ...laterMigrations.map((migration) => migration.hash)],
  );
});

test("pending migration planning applies digest SQL when only the earlier tidy migration ran", () => {
  const pendingDigest = migrationAt(REBASED_DIGEST_CREATED_AT);
  const appliedTidy = migrationAt(TIDY_CREATED_AT);
  const laterMigrations = MIGRATIONS.filter(
    (migration) => migration.folderMillis > REBASED_DIGEST_CREATED_AT,
  );

  const pending = planPendingMigrations(MIGRATIONS, [
    {
      hash: appliedTidy.hash,
      createdAt: appliedTidy.folderMillis,
    },
  ]);

  assert.deepEqual(
    pending.map((migration) => migration.hash),
    [pendingDigest.hash, ...laterMigrations.map((migration) => migration.hash)],
  );
});
