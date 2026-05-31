import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldRunMigrationsOnBoot } from "./boot-migrations.js";

test("defaults to running migrations on boot when unset", () => {
  assert.equal(shouldRunMigrationsOnBoot({} as NodeJS.ProcessEnv), true);
});

test("runs on boot when explicitly enabled", () => {
  assert.equal(
    shouldRunMigrationsOnBoot({ RUN_MIGRATIONS_ON_BOOT: "true" } as NodeJS.ProcessEnv),
    true,
  );
});

test("skips boot migrations only when explicitly set to 'false'", () => {
  assert.equal(
    shouldRunMigrationsOnBoot({ RUN_MIGRATIONS_ON_BOOT: "false" } as NodeJS.ProcessEnv),
    false,
  );
});

test("any non-'false' value still runs on boot", () => {
  assert.equal(
    shouldRunMigrationsOnBoot({ RUN_MIGRATIONS_ON_BOOT: "0" } as NodeJS.ProcessEnv),
    true,
  );
});
