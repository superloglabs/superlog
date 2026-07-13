import { metrics } from "@opentelemetry/api";
import { captureAgentPrLifecycleEvent, daysBetween, resolveIncidentOrg, schema } from "@superlog/db";
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
//
// Each terminal transition also emits the matching PostHog lifecycle event
// (agent_pr_accepted / agent_pr_rejected) for the acceptance-rate dashboard —
// same exactly-once gating as the counters: callers only invoke these after
// winning the conditional state UPDATE.
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

type PrTerminalMetricInput = {
  agentPr: schema.AgentPullRequest;
  /** When the terminal transition happened (merged_at / closed_at). */
  resolvedAt: Date;
  /** Merged only: who clicked merge, for the analytics event. */
  mergedByLogin?: string | null;
};

async function recordPrTerminalMetric(
  input: PrTerminalMetricInput,
  outcome: "merged" | "closed",
): Promise<void> {
  const { agentPr } = input;
  try {
    const org = await resolveIncidentOrg(agentPr.incidentId);
    if (org) {
      const attrs = { "tenant.org.id": org.id, "tenant.org.name": org.name };
      (outcome === "merged" ? prMergedCounter : prClosedCounter).add(1, attrs);
    }
    const daysToOutcome = daysBetween(agentPr.createdAt, input.resolvedAt);
    if (outcome === "merged") {
      captureAgentPrLifecycleEvent({
        kind: "accepted",
        pr: agentPr,
        org,
        daysToOutcome,
        mergedByLogin: input.mergedByLogin ?? null,
      });
    } else {
      captureAgentPrLifecycleEvent({
        kind: "rejected",
        pr: agentPr,
        org,
        reason: "closed_unmerged",
        daysToOutcome,
      });
    }
  } catch (err) {
    log.warn({ err, incidentId: agentPr.incidentId, outcome }, "pr terminal metric emit failed");
  }
}

/**
 * Record a PR-merged transition: increment `superlog.prs.merged` for the org
 * owning the PR's incident and emit the `agent_pr_accepted` analytics event.
 * Best-effort: a telemetry failure must never 500 the webhook. Gate the call on
 * an actual state transition (prior state != "merged") so webhook re-deliveries
 * and reopen→close cycles don't double-count.
 */
export function recordPrMergedMetric(input: PrTerminalMetricInput): Promise<void> {
  return recordPrTerminalMetric(input, "merged");
}

/**
 * Record a closed-without-merge transition: increment `superlog.prs.closed`
 * and emit `agent_pr_rejected` (reason `closed_unmerged`). Same best-effort /
 * transition-gating contract as {@link recordPrMergedMetric}.
 */
export function recordPrClosedMetric(input: PrTerminalMetricInput): Promise<void> {
  return recordPrTerminalMetric(input, "closed");
}
