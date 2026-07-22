// Lifecycle-event seam. Open-core emits vendor-neutral growth events (a user
// signed up; a project received its first telemetry) to a pluggable sink; it
// does NOT know which — if any — CRM, analytics, or ad network consumes them.
// The default sink is a no-op, so a stock / self-hosted build emits nothing and
// pulls in no third-party dependency.
//
// A deployment that wants to forward these somewhere provides a sink and calls
// registerLifecycleEventSink() from its own service entrypoint, before the app
// starts serving. Open-core never imports the sink — the dependency points only
// inward (deployment → open-core), so the destination stays out of this repo.

// The lifecycle moments we surface. Both are already emitted to server-side
// product analytics next door (see analytics.ts); this seam lets a deployment
// route the same moments to additional destinations without those destinations
// leaking into open-core.
export type LifecycleEventName = "signup" | "first_telemetry";

export type LifecycleEvent = {
  event: LifecycleEventName;
  // Stable id of the acting user (the analytics distinct id).
  userId: string;
  // Contact email when known. A sink may hash it for identity matching; the
  // seam itself neither stores nor transforms it.
  email?: string | null;
  // Stable id for this occurrence, so a sink can dedupe across delivery paths
  // (e.g. `signup-<userId>`, `first_telemetry-<projectId>`).
  dedupeId?: string;
  // Extra non-sensitive context (project/org ids, source).
  properties?: Record<string, unknown>;
};

type MaybePromise<T> = T | Promise<T>;

export interface LifecycleEventSink {
  record(event: LifecycleEvent): MaybePromise<void>;
}

const noopSink: LifecycleEventSink = {
  record() {},
};

let activeSink: LifecycleEventSink = noopSink;

/**
 * Install the sink lifecycle events are delivered to. A deployment calls this
 * once at service boot, before serving. Without it the no-op sink stays in
 * place — the expected path for stock / self-hosted builds.
 */
export function registerLifecycleEventSink(sink: LifecycleEventSink): void {
  activeSink = sink;
}

// Test/teardown helper: drop back to the no-op sink.
export function resetLifecycleEventSink(): void {
  activeSink = noopSink;
}

/**
 * Emit a lifecycle event to the installed sink. Best-effort: never throws and
 * never rejects, so callers can `await` it or fire-and-forget with `void`. A
 * no-op unless a sink was registered at boot.
 */
export async function emitLifecycleEvent(event: LifecycleEvent): Promise<void> {
  try {
    await activeSink.record(event);
  } catch {
    /* lifecycle delivery is best-effort and must not affect the caller */
  }
}
