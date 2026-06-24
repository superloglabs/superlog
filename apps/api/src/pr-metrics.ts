import { metrics } from "@opentelemetry/api";
import { db, schema } from "@superlog/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger.js";

// Per-org PR lifecycle counters, API half. PR "merged"/"closed" transitions
// arrive over the GitHub webhook (apps/api/src/github.ts), so they're counted
// here; the "created" counter is emitted by the worker when it opens the PR
// (apps/worker/src/pr-metrics.ts). Same `tenant.org.*` attributes as the gauges
// in the worker's tenant-metrics.ts so a dashboard can group all PR metrics by
// org uniformly.
//
// Monotonic cumulative counters (OTel default); the read path reconstructs the
// per-bucket increase — see cumulativeMonotonicSumQuery in src/mcp/clickhouse.ts.
const log = logger.child({ scope: "pr-metrics" });
const meter = metrics.getMeter("@superlog/api/prs");

const prMergedCounter = meter.createCounter("superlog.prs.merged", {
  description: "Agent pull requests merged, counted per org at merge time.",
  unit: "1",
});

const prClosedCounter = meter.createCounter("superlog.prs.closed", {
  description: "Agent pull requests closed without merging, counted per org.",
  unit: "1",
});

// incident → project → org, the same path the worker's tenant-metrics.ts uses.
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

async function recordPrTerminalMetric(
  incidentId: string,
  outcome: "merged" | "closed",
): Promise<void> {
  try {
    const org = await resolveIncidentOrg(incidentId);
    if (!org) return;
    const attrs = { "tenant.org.id": org.id, "tenant.org.name": org.name };
    (outcome === "merged" ? prMergedCounter : prClosedCounter).add(1, attrs);
  } catch (err) {
    log.warn({ err, incidentId, outcome }, "pr terminal metric emit failed");
  }
}

/**
 * Increment `superlog.prs.merged` for the org owning `incidentId`. Best-effort:
 * a telemetry failure must never 500 the webhook. Gate the call on an actual
 * state transition (prior state != "merged") so webhook re-deliveries and
 * reopen→close cycles don't double-count.
 */
export function recordPrMergedMetric(incidentId: string): Promise<void> {
  return recordPrTerminalMetric(incidentId, "merged");
}

/**
 * Increment `superlog.prs.closed` (closed without merge) for the org owning
 * `incidentId`. Same best-effort / transition-gating contract as
 * {@link recordPrMergedMetric}.
 */
export function recordPrClosedMetric(incidentId: string): Promise<void> {
  return recordPrTerminalMetric(incidentId, "closed");
}
