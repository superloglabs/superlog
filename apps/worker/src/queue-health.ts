// Queue and loop health gauges, exported through the worker's own OTel
// pipeline (same pattern as agent-run-health-metrics.ts), plus flat
// structured log lines that deployment-side log tooling can turn into
// alarm metrics without parsing nested JSON.
//
// Why this exists: every past worker outage (wedged ingest cursor, starved
// agent-run rotation, a queue whose consumer died) was discovered by a human
// noticing missing product behavior, hours or days late. The signals below
// make those failure modes directly observable:
//   - superlog.worker.jobs.pending / .active / .oldest_pending_age_ms per
//     pg-boss queue — a growing oldest-pending age on a queue whose consumer
//     should be draining it is the "stuck queue" page.
//   - superlog.worker.tick.heartbeat_age_ms — the tick loop's last completed
//     cycle age; a climbing heartbeat means the loop is wedged or the process
//     is stuck, regardless of which step is at fault.
import { metrics } from "@opentelemetry/api";
import { db } from "@superlog/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger.js";

const meter = metrics.getMeter("@superlog/worker/queue-health");

export type QueueHealthCounts = {
  queue: string;
  pending: number;
  active: number;
  oldestPendingAt: Date | null;
};

export type QueueHealthObservation = {
  metric: string;
  value: number;
  attributes?: Record<string, string>;
};

// The pgboss schema name is interpolated as an identifier (it can't be a
// bind parameter), so it must never carry anything but a plain identifier.
export function pgbossSchemaName(raw: string | undefined): string {
  if (raw && /^[a-z_][a-z0-9_]*$/i.test(raw)) return raw;
  return "pgboss";
}

// Process boot counts as the first heartbeat so the gauge is meaningful
// before the first tick completes (a worker that never completes one is
// exactly what the alarm must catch).
let lastTickAt: Date = new Date();

export function recordTickHeartbeat(at: Date = new Date()): void {
  lastTickAt = at;
}

export function tickHeartbeatAgeMs(now: Date = new Date()): number {
  return Math.max(0, now.getTime() - lastTickAt.getTime());
}

// Pure mapping from counts to gauge observations. Queues in the snapshot emit
// every gauge (explicit zeros) so a drained queue drops to 0 instead of its
// series freezing at the last bad value; an empty snapshot emits one zero set
// under queue.name="none" to keep the series alive.
export function buildQueueHealthObservations(
  queues: QueueHealthCounts[],
  now: Date,
): QueueHealthObservation[] {
  const observations: QueueHealthObservation[] = [];
  const emit = (queue: string, pending: number, active: number, oldestPendingAt: Date | null) => {
    const attributes = { "queue.name": queue };
    const oldestAgeMs = oldestPendingAt
      ? Math.max(0, now.getTime() - oldestPendingAt.getTime())
      : 0;
    observations.push(
      { metric: "superlog.worker.jobs.pending", value: pending, attributes },
      { metric: "superlog.worker.jobs.active", value: active, attributes },
      { metric: "superlog.worker.jobs.oldest_pending_age_ms", value: oldestAgeMs, attributes },
    );
  };
  for (const q of queues) emit(q.queue, q.pending, q.active, q.oldestPendingAt);
  if (queues.length === 0) emit("none", 0, 0, null);
  return observations;
}

// Pending = created + retry: both are jobs waiting for a consumer. A job
// sitting in either past its expected latency means the consumer is gone or
// saturated.
export async function loadQueueHealthCounts(): Promise<QueueHealthCounts[]> {
  const schema = pgbossSchemaName(process.env.PGBOSS_SCHEMA);
  const rows = (await db.execute<{
    queue: string;
    pending: number;
    active: number;
    oldest_pending: Date | null;
  }>(sql`
    SELECT
      name AS queue,
      count(*) FILTER (WHERE state IN ('created', 'retry'))::int AS pending,
      count(*) FILTER (WHERE state = 'active')::int AS active,
      min(created_on) FILTER (WHERE state IN ('created', 'retry')) AS oldest_pending
    FROM ${sql.raw(schema)}.job
    WHERE state IN ('created', 'retry', 'active')
    GROUP BY 1
  `)) as unknown as Array<{
    queue: string;
    pending: number;
    active: number;
    oldest_pending: Date | string | null;
  }>;
  return rows.map((r) => ({
    queue: r.queue,
    pending: Number(r.pending),
    active: Number(r.active),
    oldestPendingAt: r.oldest_pending ? new Date(r.oldest_pending) : null,
  }));
}

// A queue that drains out of the snapshot (the pgboss query only returns
// queues with live jobs) gets one explicit all-zero entry so its series ends
// at 0 instead of freezing at the last non-zero value. `previous` tracks the
// queues the snapshot contained, so recovery zeros live exactly one pass —
// same convention as agent-run-health-metrics' withRecoveryZeros.
export function withQueueRecoveryZeros(
  current: QueueHealthCounts[],
  previous: ReadonlySet<string>,
): QueueHealthCounts[] {
  const seen = new Set(current.map((q) => q.queue));
  const out = [...current];
  for (const queue of previous) {
    if (seen.has(queue)) continue;
    out.push({ queue, pending: 0, active: 0, oldestPendingAt: null });
  }
  return out;
}

let cached: { at: number; counts: QueueHealthCounts[] } | null = null;
const CACHE_TTL_MS = 30_000;
let previousSnapshotQueues = new Set<string>();
// Structured log cadence for deployment-side metric filters — one flat line
// per queue plus one heartbeat line, once a minute.
const LOG_INTERVAL_MS = 60_000;
let lastLoggedAt = 0;

async function snapshot(): Promise<QueueHealthCounts[]> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.counts;
  const counts = await loadQueueHealthCounts();
  const withZeros = withQueueRecoveryZeros(counts, previousSnapshotQueues);
  previousSnapshotQueues = new Set(counts.map((q) => q.queue));
  cached = { at: Date.now(), counts: withZeros };
  return withZeros;
}

function logQueueHealth(counts: QueueHealthCounts[], now: Date): void {
  if (now.getTime() - lastLoggedAt < LOG_INTERVAL_MS) return;
  lastLoggedAt = now.getTime();
  for (const q of counts) {
    logger.info(
      {
        scope: "queue-health",
        queue: q.queue,
        pending: q.pending,
        active: q.active,
        oldest_pending_ms: q.oldestPendingAt
          ? Math.max(0, now.getTime() - q.oldestPendingAt.getTime())
          : 0,
      },
      "queue health",
    );
  }
  logger.info({ scope: "queue-health", tick_age_ms: tickHeartbeatAgeMs(now) }, "tick heartbeat");
}

export function registerQueueHealthMetrics(): void {
  const pending = meter.createObservableGauge("superlog.worker.jobs.pending", {
    description: "pg-boss jobs waiting for a consumer (created + retry), by queue.",
  });
  const active = meter.createObservableGauge("superlog.worker.jobs.active", {
    description: "pg-boss jobs currently being processed, by queue.",
  });
  const oldestAge = meter.createObservableGauge("superlog.worker.jobs.oldest_pending_age_ms", {
    description: "Age of the oldest pending pg-boss job, by queue.",
  });
  const heartbeat = meter.createObservableGauge("superlog.worker.tick.heartbeat_age_ms", {
    description: "Milliseconds since the worker loop last completed a cycle.",
  });
  const gaugeFor = (metric: string) =>
    metric === "superlog.worker.jobs.pending"
      ? pending
      : metric === "superlog.worker.jobs.active"
        ? active
        : oldestAge;

  meter.addBatchObservableCallback(
    async (result) => {
      const now = new Date();
      result.observe(heartbeat, tickHeartbeatAgeMs(now));
      try {
        const counts = await snapshot();
        for (const obs of buildQueueHealthObservations(counts, now)) {
          result.observe(gaugeFor(obs.metric), obs.value, obs.attributes);
        }
        logQueueHealth(counts, now);
      } catch (err) {
        logger.error({ err, scope: "queue-health" }, "queue health observe failed");
      }
    },
    [pending, active, oldestAge, heartbeat],
  );
}
