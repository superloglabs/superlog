// Background-job discovery. Files in the jobs dir (./jobs/) that export a `job`
// are picked up at boot and scheduled on a pg-boss queue (see jobs/runner.ts),
// running OUTSIDE the worker tick loop so a long job never blocks telemetry
// ingest, alerts, or agent-runs.
//
// The folder is a build seam as much as a convention: a deployment can overlay
// extra job files into ./jobs/ at image-build time without this repo having to
// name or know about them. An empty ./jobs/ dir — the default — schedules
// nothing, so stock builds are unaffected.

import { readdir } from "node:fs/promises";
import type { ClickHouseClient } from "@clickhouse/client";
import type { DB } from "@superlog/db";
import { logger } from "./logger.js";

// Everything a job might need to do its work. Kept deliberately small; widen it
// only when a real job needs more.
export type JobDeps = {
  db: DB;
  clickhouse: Pick<ClickHouseClient, "query">;
};

// The unit of work for a scheduled job: run once per fire. pg-boss owns the
// schedule, retries, and single-active semantics, so handlers do NOT self-gate
// or loop — they just do one pass.
export type JobHandler = () => Promise<void>;

// The shape each file in the jobs dir exports as `job`.
export type JobDefinition = {
  name: string;
  // 5-field cron expression (minute precision); pg-boss checks every 30s.
  schedule: string;
  // create() receives the shared deps and returns the handler — or null to opt
  // out (e.g. a required env var / API key is absent), in which case the job is
  // skipped entirely.
  create: (deps: JobDeps) => JobHandler | null | Promise<JobHandler | null>;
};

// A discovered, ready-to-schedule job.
export type LoadedJob = {
  name: string;
  schedule: string;
  handler: JobHandler;
};

type JobModule = { job?: unknown };

const DEFAULT_JOBS_DIR = new URL("./jobs/", import.meta.url);

function isJobFile(name: string): boolean {
  if (name.endsWith(".d.ts")) return false;
  if (name.endsWith(".test.ts") || name.endsWith(".test.js")) return false;
  return name.endsWith(".ts") || name.endsWith(".js");
}

function isJobDefinition(value: unknown): value is JobDefinition {
  if (!value || typeof value !== "object") return false;
  const def = value as Partial<JobDefinition>;
  return (
    typeof def.name === "string" &&
    typeof def.schedule === "string" &&
    def.schedule.length > 0 &&
    typeof def.create === "function"
  );
}

// Scan the jobs directory, import each job file, and return the jobs that opted
// in (create() returned a handler). Resilient by design: a missing directory
// yields an empty list, and a file that fails to import / throws in create() /
// exports no valid job is logged and skipped, so one bad job can never block
// worker boot.
export async function loadJobs(deps: JobDeps, options: { dir?: URL } = {}): Promise<LoadedJob[]> {
  const dir = options.dir ?? DEFAULT_JOBS_DIR;

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const files = entries.filter(isJobFile).sort();
  const jobs: LoadedJob[] = [];

  for (const file of files) {
    const specifier = new URL(file, dir).href;
    try {
      const mod = (await import(specifier)) as JobModule;
      if (!isJobDefinition(mod.job)) {
        logger.warn({ scope: "jobs.load", file }, "jobs dir file exports no valid `job`; skipping");
        continue;
      }
      const def = mod.job;
      const handler = await def.create(deps);
      if (!handler) {
        logger.info({ scope: "jobs.load", job: def.name }, "job opted out at create(); skipping");
        continue;
      }
      jobs.push({ name: def.name, schedule: def.schedule, handler });
      logger.info(
        { scope: "jobs.load", job: def.name, schedule: def.schedule },
        "discovered background job",
      );
    } catch (err) {
      logger.error(
        { scope: "jobs.load", file, err: err instanceof Error ? err.message : String(err) },
        "failed to load background job; skipping",
      );
    }
  }

  return jobs;
}
