import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveMigrationConnection } from "./migrate.js";

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
