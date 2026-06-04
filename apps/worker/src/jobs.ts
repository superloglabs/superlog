// Background-job registry. The worker runs a fixed set of built-in ticks
// (telemetry ingest, alerts, digests, …) from worker/tick.ts; this module adds
// a convention-over-configuration way to contribute *additional* recurring
// jobs: drop a file in ./jobs/ that exports a `job`, and it gets picked up at
// boot and run inside the same tick loop.
//
// The point of the folder convention is the build seam. A stock checkout ships
// whatever jobs live in ./jobs/ here; a deployment can overlay extra job files
// into that same directory at image-build time (the way the managed-agent
// runtime and AI-usage sink are overlaid) without this repo having to name or
// know about them. An empty ./jobs/ dir — the default — registers nothing, so
// stock builds are unaffected.

import { readdir } from "node:fs/promises";
import type { ClickHouseClient } from "@clickhouse/client";
import type { DB } from "@superlog/db";
import { logger } from "./logger.js";

// A job's unit of work: run a slice, return how many items it processed (0 when
// it had nothing to do — e.g. an interval-gated job between runs). Mirrors the
// built-in tick functions so jobs slot into the same `safe()` loop.
export type JobTick = () => Promise<number>;

// Everything a job might need to do its work. Kept deliberately small; widen it
// only when a real job needs more.
export type JobDeps = {
  db: DB;
  clickhouse: Pick<ClickHouseClient, "query">;
};

// A registered, ready-to-run job.
export type Job = {
  name: string;
  tick: JobTick;
};

// The shape each file in the jobs dir exports as `job`. create() receives the
// shared deps and returns a ticker — or null to opt out (e.g. a required API
// key is absent), in which case the loader skips it entirely.
export type JobDefinition = {
  name: string;
  create: (deps: JobDeps) => JobTick | null | Promise<JobTick | null>;
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
  return typeof def.name === "string" && typeof def.create === "function";
}

// Scan the jobs directory, import each job file, and return the tickers of the
// jobs that opted in. Resilient by design: a missing directory yields an empty
// list, and a file that fails to import / throws in create() / exports no valid
// job is logged and skipped so one bad job can never take down worker boot.
export async function loadJobs(deps: JobDeps, options: { dir?: URL } = {}): Promise<Job[]> {
  const dir = options.dir ?? DEFAULT_JOBS_DIR;

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const files = entries.filter(isJobFile).sort();
  const jobs: Job[] = [];

  for (const file of files) {
    const specifier = new URL(file, dir).href;
    try {
      const mod = (await import(specifier)) as JobModule;
      if (!isJobDefinition(mod.job)) {
        logger.warn({ scope: "jobs.load", file }, "jobs dir file exports no valid `job`; skipping");
        continue;
      }
      const def = mod.job;
      const tick = await def.create(deps);
      if (!tick) {
        logger.info({ scope: "jobs.load", job: def.name }, "job opted out at create(); skipping");
        continue;
      }
      jobs.push({ name: def.name, tick });
      logger.info({ scope: "jobs.load", job: def.name }, "registered background job");
    } catch (err) {
      logger.error(
        { scope: "jobs.load", file, err: err instanceof Error ? err.message : String(err) },
        "failed to load background job; skipping",
      );
    }
  }

  return jobs;
}
