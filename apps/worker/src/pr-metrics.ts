import { metrics } from "@opentelemetry/api";
import { db, schema } from "@superlog/db";
import { eq } from "drizzle-orm";
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

// incident → project → org, the same path tenant-metrics.ts uses. Returns null
// when the incident (or its project/org) can't be resolved so callers can skip
// emitting rather than fabricate an attribute set.
async function resolveIncidentOrg(
  incidentId: string,
): Promise<{ id: string; name: string } | null> {
  const rows = await db
    .select({ id: schema.orgs.id, name: schema.orgs.name })
    .from(schema.incidents)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.incidents.projectId))
    .innerJoin(schema.orgs, eq(schema.orgs.id, schema.projects.orgId))
    .where(eq(schema.incidents.id, incidentId))
    .limit(1);
  return rows[0] ?? null;
}

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
