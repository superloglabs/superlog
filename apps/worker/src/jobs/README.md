# Background jobs

Files in this directory are auto-discovered at worker boot by `loadJobs()` in
`../jobs.ts` and run inside the main tick loop (`../worker/tick.ts`), alongside
the built-in ticks (telemetry ingest, alerts, digests, …).

To add a job, drop a file here that exports a `job`:

```ts
import type { JobDefinition } from "../jobs.js";

export const job: JobDefinition = {
  name: "my-thing.sync",
  // Receives shared deps; return a ticker, or null to opt out (e.g. a required
  // env var is missing). The ticker returns how many items it processed (0 when
  // it had nothing to do — interval-gate inside the ticker if it should not run
  // every poll).
  create: ({ db, clickhouse }) => createMyTicker({ db, clickhouse }),
};
```

Rules the loader enforces:

- `*.test.ts` and `*.d.ts` files are ignored.
- A file that fails to import, throws in `create()`, or exports no valid `job`
  is logged and skipped — one bad job never blocks worker boot.
- Files load in filename-sorted order.

This is a build seam as much as a convention: a deployment can overlay
additional job files into this directory at image-build time without this
repository having to know about them, the same way the managed-agent runtime
and AI-usage sink are overlaid.
