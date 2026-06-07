# Background jobs

Files in this directory are auto-discovered at worker boot by `loadJobs()` in
`../jobs.ts` and scheduled on their own [pg-boss](https://github.com/timgit/pg-boss)
queue by `runner.ts` — they run **outside** the worker tick loop, so a long job
never blocks telemetry ingest, alerts, or agent-runs.

To add a job, drop a file here that exports a `job`:

```ts
import type { JobDefinition } from "../jobs.js";

export const job: JobDefinition = {
  name: "my-thing.sync",
  // 5-field cron (minute precision; pg-boss checks schedules every 30s).
  schedule: "0 */6 * * *",
  // Receives shared deps; return a handler that does ONE pass, or null to opt
  // out (e.g. a required env var is missing). pg-boss owns scheduling, retries,
  // and single-active semantics — handlers do not loop or self-gate.
  create: ({ db, clickhouse }) => async () => {
    await doTheWork(db, clickhouse);
  },
};
```

Rules the loader enforces:

- `*.test.ts` and `*.d.ts` files are ignored.
- A file that fails to import, throws in `create()`, or exports no valid `job`
  (needs a `name`, a non-empty `schedule`, and a `create` function) is logged
  and skipped — one bad job never blocks worker boot.
- Files load in filename-sorted order.

Each job gets an `exclusive` pg-boss queue (at most one queued-or-active at a
time), so a slow run never overlaps its next schedule.

This is a build seam as much as a convention: a deployment can overlay
additional job files into this directory at image-build time without this
repository having to know about them, the same way the managed-agent runtime
and AI-usage sink are overlaid.

## Schema / privileges

pg-boss stores its state in a dedicated `pgboss` schema. Creating it requires
`CREATE` on the database. Local/self-host roles usually have that, so the
runner self-installs (`migrate: true`). Where the runtime role is DML-only, set
`PGBOSS_MIGRATE=false` and install/migrate the schema ahead of time as a
privileged role (e.g. in the same gated step that runs Drizzle migrations).
