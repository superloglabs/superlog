// Standalone migration entrypoint. Run as `pnpm --filter @superlog/db migrate`.
//
// This is what the prod migration ECS task executes (as the schema-owner role,
// gated before any service rolls out) and what local/CI flows can call directly.
// It exits non-zero on failure so a CI runner or ECS RunTask waiter can treat a
// failed migration as a hard stop instead of silently proceeding to deploy app
// code against an unmigrated database.
import { runMigrations } from "./migrate.js";

runMigrations()
  .then(() => {
    console.log("[migrate] migrations applied");
    process.exit(0);
  })
  .catch((err) => {
    console.error("[migrate] migration failed:", err instanceof Error ? err.stack : err);
    process.exit(1);
  });
