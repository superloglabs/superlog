// Telemetry usage metering — PURE core (no DB / ClickHouse / network imports so
// it's unit-testable in isolation). Autumn meters usage but we can't call
// track() per event (billions of spans), so a worker ticker periodically counts
// NEW events per project from ClickHouse (bounded window, durable cursor — same
// pattern as the issue-ingest tick), aggregates them per ORG (the Autumn
// customer), and reports the delta via Autumn's additive track(). The concrete
// ClickHouse/Postgres/Autumn adapters live in usage-meter-ticker.ts.
//
// track() is additive and not idempotent, so we advance the cursor even if a
// track call fails (at-most-once): a transient error under-reports one window
// rather than risk double-charging on retry. Failures are logged.
import { logger } from "../logger.js";

// Telemetry signals → Autumn feature ids (must match autumn.config.ts).
export const SIGNAL_FEATURE_IDS = {
  spans: "spans",
  logs: "logs",
  metric_points: "metric_points",
} as const;
export type UsageSignal = keyof typeof SIGNAL_FEATURE_IDS;

export const CURSOR_PREFIX = "usage-meter-";

// Sum per-project event counts into per-org totals, dropping projects with no
// known org (e.g. deleted between ingest and metering). Pure.
export function aggregateByOrg(
  perProject: Map<string, number>,
  projectToOrg: Map<string, string>,
): Map<string, number> {
  const perOrg = new Map<string, number>();
  for (const [projectId, count] of perProject) {
    const orgId = projectToOrg.get(projectId);
    if (!orgId || count <= 0) continue;
    perOrg.set(orgId, (perOrg.get(orgId) ?? 0) + count);
  }
  return perOrg;
}

export type UsageMeterDeps = {
  // Count events per project_id for a signal in (afterIso, untilIso].
  countByProject: (
    signal: UsageSignal,
    afterIso: string,
    untilIso: string,
  ) => Promise<Map<string, number>>;
  resolveOrgIds: (projectIds: string[]) => Promise<Map<string, string>>;
  track: (orgId: string, featureId: string, value: number) => Promise<void>;
  getCursor: (name: string) => Promise<Date>;
  setCursor: (name: string, at: Date) => Promise<void>;
  now: () => Date;
  windowMs: number;
};

// One metering pass over all three signals. Returns the number of (org, signal)
// usage deltas reported. Injected deps keep it unit-testable without CH/Autumn.
export async function meterTelemetryUsageTick(deps: UsageMeterDeps): Promise<number> {
  let reported = 0;
  for (const signal of Object.keys(SIGNAL_FEATURE_IDS) as UsageSignal[]) {
    try {
      const cursorName = `${CURSOR_PREFIX}${signal}`;
      const cursor = await deps.getCursor(cursorName);
      const until = new Date(Math.min(cursor.getTime() + deps.windowMs, deps.now().getTime()));
      if (until.getTime() <= cursor.getTime()) continue; // nothing new to scan yet

      const perProject = await deps.countByProject(
        signal,
        cursor.toISOString(),
        until.toISOString(),
      );
      const orgMap = perProject.size > 0 ? await deps.resolveOrgIds([...perProject.keys()]) : null;
      // Complete the idempotent reads before advancing, then persist the cursor
      // BEFORE issuing the non-idempotent track() calls. track() is additive, so
      // a setCursor failure AFTER tracking would replay this window next tick and
      // double-charge. Advancing first makes tracking strictly at-most-once: a
      // track failure below under-reports one window rather than risk double-count.
      await deps.setCursor(cursorName, until);
      if (orgMap) {
        for (const [orgId, value] of aggregateByOrg(perProject, orgMap)) {
          try {
            await deps.track(orgId, SIGNAL_FEATURE_IDS[signal], value);
            reported += 1;
          } catch (err) {
            logger.error(
              {
                scope: "billing.usage",
                signal,
                orgId,
                value,
                err: err instanceof Error ? err.message : String(err),
              },
              "usage track failed; window not re-reported (cursor already advanced)",
            );
          }
        }
      }
    } catch (err) {
      logger.error(
        {
          scope: "billing.usage",
          signal,
          err: err instanceof Error ? err.message : String(err),
        },
        "usage signal metering failed; continuing with remaining signals",
      );
    }
  }
  return reported;
}
