// Decouples the OTel flush (set up in apps/proxy/tracing.ts, which loads before
// the app via `node --import ./tracing.ts`) from the process shutdown sequence in
// index.ts. tracing.ts registers the flush here; index.ts invokes it AFTER it
// drains in-flight ingest work, so the flush can't race the drain and exit the
// process early — the bug that orphaned in-flight SQS messages on every deploy.
// Living in src/ keeps it inside the package tsconfig's rootDir, so index.ts can
// import it without a cross-dir violation (tracing.ts itself is outside src/).

let flush: () => Promise<void> = async () => {};

/** Called once by tracing.ts when the OTel SDK starts. */
export function setTelemetryShutdown(fn: () => Promise<void>): void {
  flush = fn;
}

/** Flush and shut down telemetry. No-op unless the SDK registered a flush. */
export function shutdownTelemetry(): Promise<void> {
  return flush();
}
