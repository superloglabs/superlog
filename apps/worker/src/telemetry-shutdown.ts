// tracing.ts loads before the worker entry point via Node's --import flag. It
// registers its SDK flush here so index.ts can run it after active work drains.
// Keeping signal ownership in the entry point prevents a faster telemetry
// handler from exiting the process while queue jobs are still active.

let flush: () => Promise<void> = async () => {};

/** Called once by tracing.ts when the telemetry SDK starts. */
export function setTelemetryShutdown(fn: () => Promise<void>): void {
  flush = fn;
}

/** Flush and shut down telemetry. No-op unless the SDK registered a flush. */
export function shutdownTelemetry(): Promise<void> {
  return flush();
}
