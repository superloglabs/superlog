// Whether the API process should apply database migrations on boot.
//
// Migrations in prod are owned by a dedicated, gated ECS task that runs as the
// schema-owner role *before* any service rolls out (see the deploy-aws
// workflow). The long-running API task connects as the DML-only `superlog_app`
// role and must NOT attempt DDL on boot — doing so is what crash-looped the API
// when migration 0053 shipped. The prod deploy therefore sets
// RUN_MIGRATIONS_ON_BOOT=false.
//
// Locally (overmind, plain `pnpm dev`) there's no separate migrate step, so the
// default is to run on boot — preserving the existing developer experience.
// Worktree bootstrap already migrates explicitly, so this only affects the
// main-checkout dev loop.
export function shouldRunMigrationsOnBoot(env: NodeJS.ProcessEnv): boolean {
  return env.RUN_MIGRATIONS_ON_BOOT !== "false";
}
