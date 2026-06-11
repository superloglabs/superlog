import { metrics } from "@opentelemetry/api";
import { db } from "@superlog/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger.js";

// Agent-run health gauges, exported through the worker's own OTel pipeline
// (same pattern as tenant-metrics.ts). These power dashboards/alerts on
// investigations piling up in a bad state: failures by reason, runs stuck
// past their runtime budget, and current queue depth.

const meter = metrics.getMeter("@superlog/worker/agent-runs");

export type AgentRunHealthCounts = {
  // state='failed' within the recent window, keyed by failure_reason.
  failedRecentByReason: Record<string, number>;
  completedRecent: number;
  // Non-terminal, non-human-gated runs older than the stuck threshold.
  stuck: number;
  queued: number;
  awaitingHuman: number;
};

export type AgentRunHealthObservation = {
  metric: string;
  value: number;
  attributes?: Record<string, string>;
};

// The 1h window matches "how bad is it right now" rather than all-time
// counters; the 2h stuck threshold sits above the 90-minute default
// maxRuntimeMinutes, so anything non-terminal past it has outlived its own
// budget. awaiting_human is excluded from stuck — parked on a human is
// waiting, not stuck — but exposed as its own gauge.
export async function loadAgentRunHealthCounts(): Promise<AgentRunHealthCounts> {
  const failedRows = (await db.execute<{ reason: string; count: number }>(sql`
    SELECT coalesce(nullif(failure_reason, ''), 'unknown') AS reason, count(*)::int AS count
    FROM agent_runs
    WHERE state = 'failed' AND updated_at > now() - interval '1 hour'
    GROUP BY 1
  `)) as unknown as Array<{ reason: string; count: number }>;

  const gaugeRows = (await db.execute<{
    completed: number;
    stuck: number;
    queued: number;
    awaiting: number;
  }>(sql`
    SELECT
      count(*) FILTER (WHERE state = 'complete' AND updated_at > now() - interval '1 hour')::int AS completed,
      count(*) FILTER (
        WHERE state NOT IN ('complete', 'failed', 'awaiting_human')
          AND created_at < now() - interval '2 hours'
      )::int AS stuck,
      count(*) FILTER (WHERE state = 'queued')::int AS queued,
      count(*) FILTER (WHERE state = 'awaiting_human')::int AS awaiting
    FROM agent_runs
  `)) as unknown as Array<{ completed: number; stuck: number; queued: number; awaiting: number }>;

  const gauges = gaugeRows[0] ?? { completed: 0, stuck: 0, queued: 0, awaiting: 0 };
  return {
    failedRecentByReason: Object.fromEntries(failedRows.map((r) => [r.reason, Number(r.count)])),
    completedRecent: Number(gauges.completed),
    stuck: Number(gauges.stuck),
    queued: Number(gauges.queued),
    awaitingHuman: Number(gauges.awaiting),
  };
}

// Pure mapping from counts to gauge observations — kept separate from the OTel
// callback so it's unit-testable. A zero-failure pass still emits an explicit
// zero (failure.reason="none") so charts drop to 0 instead of holding the last
// bad value when a reason's series stops being observed.
export function buildAgentRunHealthObservations(
  counts: AgentRunHealthCounts,
): AgentRunHealthObservation[] {
  const observations: AgentRunHealthObservation[] = [
    { metric: "superlog.agent_runs.stuck", value: counts.stuck },
    { metric: "superlog.agent_runs.queued", value: counts.queued },
    { metric: "superlog.agent_runs.awaiting_human", value: counts.awaitingHuman },
    { metric: "superlog.agent_runs.completed_recent", value: counts.completedRecent },
  ];
  const reasons = Object.entries(counts.failedRecentByReason);
  if (reasons.length === 0) {
    observations.push({
      metric: "superlog.agent_runs.failed_recent",
      value: 0,
      attributes: { "failure.reason": "none" },
    });
  }
  for (const [reason, count] of reasons) {
    observations.push({
      metric: "superlog.agent_runs.failed_recent",
      value: count,
      attributes: { "failure.reason": reason },
    });
  }
  return observations;
}

let cached: { at: number; counts: AgentRunHealthCounts } | null = null;
const CACHE_TTL_MS = 30_000;

async function snapshot(): Promise<AgentRunHealthCounts> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.counts;
  const counts = await loadAgentRunHealthCounts();
  cached = { at: Date.now(), counts };
  return counts;
}

export function registerAgentRunHealthMetrics(): void {
  const gauges = {
    "superlog.agent_runs.failed_recent": meter.createObservableGauge(
      "superlog.agent_runs.failed_recent",
      { description: "Agent runs that failed in the last hour, by failure.reason." },
    ),
    "superlog.agent_runs.stuck": meter.createObservableGauge("superlog.agent_runs.stuck", {
      description: "Non-terminal agent runs (excluding awaiting_human) older than 2 hours.",
    }),
    "superlog.agent_runs.queued": meter.createObservableGauge("superlog.agent_runs.queued", {
      description: "Agent runs currently queued.",
    }),
    "superlog.agent_runs.awaiting_human": meter.createObservableGauge(
      "superlog.agent_runs.awaiting_human",
      { description: "Agent runs parked on a human response." },
    ),
    "superlog.agent_runs.completed_recent": meter.createObservableGauge(
      "superlog.agent_runs.completed_recent",
      { description: "Agent runs that completed in the last hour." },
    ),
  } as const;

  meter.addBatchObservableCallback(
    async (result) => {
      try {
        const counts = await snapshot();
        for (const obs of buildAgentRunHealthObservations(counts)) {
          result.observe(gauges[obs.metric as keyof typeof gauges], obs.value, obs.attributes);
        }
      } catch (err) {
        logger.error({ err, scope: "agent-run-health-metrics" }, "agent run health observe failed");
      }
    },
    Object.values(gauges),
  );
}
