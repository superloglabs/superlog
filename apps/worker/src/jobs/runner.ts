// pg-boss-backed runner for discovered background jobs. Each job gets its own
// queue with an `exclusive` policy (at most one queued-or-active at a time) and
// a cron schedule; pg-boss polls and runs the handler out-of-band, so jobs
// never block the worker's tick loop.
//
// In prod the worker connects as a DML-only role that cannot run DDL, so the
// pgboss schema is installed/migrated ahead of time by the gated migrate task
// and the runtime is started with migrate:false (PGBOSS_MIGRATE=false). Locally
// the connecting role can CREATE, so it self-installs.

import { PgBoss } from "pg-boss";
import { type JobDeps, type LoadedJob, loadJobs } from "../jobs.js";
import { logger } from "../logger.js";

// The slice of the pg-boss API the runner uses. Declared as an interface so
// registerJobs can be tested with a fake, no database required.
export interface JobBoss {
  start(): Promise<unknown>;
  createQueue(name: string, options?: unknown): Promise<unknown>;
  work(name: string, handler: (jobs: unknown[]) => Promise<unknown>): Promise<unknown>;
  schedule(name: string, cron: string, data?: unknown, options?: unknown): Promise<unknown>;
}

// Start the boss and register every job: one exclusive queue + worker + cron
// schedule each. A failure registering one job is logged and skipped so it
// can't block the others or worker boot.
export async function registerJobs(boss: JobBoss, jobs: LoadedJob[]): Promise<void> {
  await boss.start();
  for (const job of jobs) {
    try {
      await boss.createQueue(job.name, { policy: "exclusive" });
      await boss.work(job.name, async () => {
        await job.handler();
      });
      await boss.schedule(job.name, job.schedule);
      logger.info(
        { scope: "jobs.runner", job: job.name, schedule: job.schedule },
        "scheduled background job",
      );
    } catch (err) {
      logger.error(
        {
          scope: "jobs.runner",
          job: job.name,
          err: err instanceof Error ? err.message : String(err),
        },
        "failed to schedule background job; skipping",
      );
    }
  }
}

// Boot the job runner: construct pg-boss from the environment, discover jobs
// from the jobs dir, and schedule them. Returns the PgBoss instance (or null
// when DATABASE_URL is unset) so the caller can stop it on shutdown and
// register send-on-demand queues (e.g. issue transitions). The boss starts
// even when the jobs dir is empty — cron jobs are only one of its consumers.
export async function startJobRunner(deps: JobDeps): Promise<PgBoss | null> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    logger.warn({ scope: "jobs.runner" }, "DATABASE_URL unset; background job runner disabled");
    return null;
  }

  const jobs = await loadJobs(deps);

  const boss = new PgBoss({
    connectionString,
    schema: process.env.PGBOSS_SCHEMA || "pgboss",
    // The DML-only prod role can't run DDL; the migrate task installs the schema
    // and the render forces this false. Local/self-host roles can CREATE, so it
    // defaults on and self-installs.
    migrate: process.env.PGBOSS_MIGRATE !== "false",
  });
  boss.on("error", (err: Error) =>
    logger.error({ scope: "jobs.runner", err: err.message }, "pg-boss error"),
  );

  await registerJobs(boss, jobs);
  logger.info(
    { scope: "jobs.runner", jobs: jobs.map((j) => j.name) },
    "background job runner started",
  );
  return boss;
}
