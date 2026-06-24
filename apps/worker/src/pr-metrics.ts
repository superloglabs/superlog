import { metrics } from "@opentelemetry/api";
import { resolveIncidentOrg } from "@superlog/db";
import { logger } from "./logger.js";

// Per-org PR lifecycle counters. The "created" half lives in the worker because
// that's where we open the PR; the "merged"/"closed" halves live in the API
// (apps/api/src/pr-metrics.ts) because those transitions arrive over the GitHub
// webhook. All three carry the same `tenant.org.*` attributes as the gauges in
// tenant-metrics.ts so a dashboard can group every PR metric by org uniformly.
//
// These are monotonic cumulative counters (OTel default). To chart per-period
// activity ("PRs opened this week") the read path reconstructs the per-bucket
// increase — see cumulativeMonotonicSumQuery in apps/api/src/mcp/clickhouse.ts.
const meter = metrics.getMeter("@superlog/worker/prs");

const prCreatedCounter = meter.createCounter("superlog.prs.created", {
  description: "Agent pull requests opened, counted per org at open time.",
  unit: "1",
});

/**
 * Increment `superlog.prs.created` for the org owning `incidentId`. Best-effort:
 * a telemetry failure must never break PR delivery, so all errors are swallowed
 * after a warn. Call this only when a PR row was newly inserted (not on the
 * idempotent no-op path) so retries don't double-count.
 */
export async function recordPrCreatedMetric(incidentId: string): Promise<void> {
  try {
    const org = await resolveIncidentOrg(incidentId);
    if (!org) return;
    prCreatedCounter.add(1, { "tenant.org.id": org.id, "tenant.org.name": org.name });
  } catch (err) {
    logger.warn({ err, scope: "pr-metrics", incidentId }, "pr.created metric emit failed");
  }
}
