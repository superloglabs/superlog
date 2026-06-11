import { metrics } from "@opentelemetry/api";
import { db } from "@superlog/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger.js";

// Agent-run health gauges, exported through the worker's own OTel pipeline
// (same pattern as tenant-metrics.ts). These power dashboards/alerts on
// investigations piling up in a bad state: failures by reason, runs stuck
// past their runtime budget, and current queue depth. Every observation
// carries tenant.org.id / tenant.org.name (the tenant-metrics convention) so
// dashboards can group by org.

const meter = metrics.getMeter("@superlog/worker/agent-runs");

export type AgentRunOrgHealthCounts = {
  orgId: string;
  orgName: string;
  // state='failed' within the recent window, keyed by failure_reason.
  failedRecentByReason: Record<string, number>;
  completedRecent: number;
  // Actively-moving states that stopped moving (older than the stuck threshold).
  stuck: number;
  queued: number;
  awaitingHuman: number;
  // Runs parked on missing prerequisites (e.g. no GitHub connected).
  blocked: number;
};

// States that should always be progressing on their own. Anything here older
// than the stuck threshold has genuinely wedged. Deliberately an allow-list:
// parked states (awaiting_human, blocked_no_github, superseded, and whatever
// gets added next) accumulate by design — counting them as stuck pins the
// gauge at a permanently-elevated baseline and makes it unreadable.
const ACTIVE_RUN_STATES = ["queued", "repo_discovery", "running", "pr_retry_queued"] as const;

export type AgentRunHealthObservation = {
  metric: string;
  value: number;
  attributes?: Record<string, string>;
};

// The 1h window matches "how bad is it right now" rather than all-time
// counters; the 2h stuck threshold sits above the 90-minute default
// maxRuntimeMinutes, so any active run past it has outlived its own budget.
// Parked states are not stuck: awaiting_human and blocked runs each get their
// own gauge instead.
//
// Orgs whose runs are all in old terminal states (every gauge zero, no recent
// failures) are dropped: emitting permanent zeros for every org that ever ran
// an investigation would grow export volume without adding information.
export async function loadAgentRunHealthCounts(): Promise<AgentRunOrgHealthCounts[]> {
  const failedRows = (await db.execute<{
    org_id: string;
    org_name: string;
    reason: string;
    count: number;
  }>(sql`
    SELECT
      o.id AS org_id,
      o.name AS org_name,
      coalesce(nullif(ar.failure_reason, ''), 'unknown') AS reason,
      count(*)::int AS count
    FROM agent_runs ar
    JOIN incidents i ON i.id = ar.incident_id
    JOIN projects p ON p.id = i.project_id
    JOIN orgs o ON o.id = p.org_id
    WHERE ar.state = 'failed' AND ar.updated_at > now() - interval '1 hour'
    GROUP BY 1, 2, 3
  `)) as unknown as Array<{ org_id: string; org_name: string; reason: string; count: number }>;

  const gaugeRows = (await db.execute<{
    org_id: string;
    org_name: string;
    completed: number;
    stuck: number;
    queued: number;
    awaiting: number;
    blocked: number;
  }>(sql`
    SELECT
      o.id AS org_id,
      o.name AS org_name,
      count(*) FILTER (WHERE ar.state = 'complete' AND ar.updated_at > now() - interval '1 hour')::int AS completed,
      count(*) FILTER (
        WHERE ar.state IN (${sql.join(
          ACTIVE_RUN_STATES.map((s) => sql`${s}`),
          sql`, `,
        )})
          AND ar.created_at < now() - interval '2 hours'
      )::int AS stuck,
      count(*) FILTER (WHERE ar.state = 'queued')::int AS queued,
      count(*) FILTER (WHERE ar.state = 'awaiting_human')::int AS awaiting,
      count(*) FILTER (WHERE ar.state LIKE 'blocked_%')::int AS blocked
    FROM agent_runs ar
    JOIN incidents i ON i.id = ar.incident_id
    JOIN projects p ON p.id = i.project_id
    JOIN orgs o ON o.id = p.org_id
    GROUP BY 1, 2
  `)) as unknown as Array<{
    org_id: string;
    org_name: string;
    completed: number;
    stuck: number;
    queued: number;
    awaiting: number;
    blocked: number;
  }>;

  const byOrg = new Map<string, AgentRunOrgHealthCounts>();
  const orgEntry = (orgId: string, orgName: string): AgentRunOrgHealthCounts => {
    let entry = byOrg.get(orgId);
    if (!entry) {
      entry = {
        orgId,
        orgName,
        failedRecentByReason: {},
        completedRecent: 0,
        stuck: 0,
        queued: 0,
        awaitingHuman: 0,
        blocked: 0,
      };
      byOrg.set(orgId, entry);
    }
    return entry;
  };

  for (const r of gaugeRows) {
    const entry = orgEntry(r.org_id, r.org_name);
    entry.completedRecent = Number(r.completed);
    entry.stuck = Number(r.stuck);
    entry.queued = Number(r.queued);
    entry.awaitingHuman = Number(r.awaiting);
    entry.blocked = Number(r.blocked);
  }
  for (const r of failedRows) {
    orgEntry(r.org_id, r.org_name).failedRecentByReason[r.reason] = Number(r.count);
  }

  return [...byOrg.values()].filter(
    (o) =>
      o.completedRecent > 0 ||
      o.stuck > 0 ||
      o.queued > 0 ||
      o.awaitingHuman > 0 ||
      o.blocked > 0 ||
      Object.keys(o.failedRecentByReason).length > 0,
  );
}

// Pure mapping from counts to gauge observations — kept separate from the OTel
// callback so it's unit-testable. Orgs in the snapshot emit every gauge
// (including zeros) so a recovered org drops to 0 instead of freezing at its
// last bad value. When nothing is failing anywhere, an explicit zero with
// failure.reason="none" keeps the failed_recent series alive; an empty
// snapshot does the same for every gauge.
export function buildAgentRunHealthObservations(
  orgs: AgentRunOrgHealthCounts[],
): AgentRunHealthObservation[] {
  const observations: AgentRunHealthObservation[] = [];
  let failedObserved = 0;

  for (const org of orgs) {
    const attrs = { "tenant.org.id": org.orgId, "tenant.org.name": org.orgName };
    observations.push(
      { metric: "superlog.agent_runs.stuck", value: org.stuck, attributes: attrs },
      { metric: "superlog.agent_runs.queued", value: org.queued, attributes: attrs },
      { metric: "superlog.agent_runs.awaiting_human", value: org.awaitingHuman, attributes: attrs },
      { metric: "superlog.agent_runs.blocked", value: org.blocked, attributes: attrs },
      { metric: "superlog.agent_runs.completed_recent", value: org.completedRecent, attributes: attrs },
    );
    for (const [reason, count] of Object.entries(org.failedRecentByReason)) {
      failedObserved++;
      observations.push({
        metric: "superlog.agent_runs.failed_recent",
        value: count,
        attributes: { ...attrs, "failure.reason": reason },
      });
    }
  }

  if (orgs.length === 0) {
    observations.push(
      { metric: "superlog.agent_runs.stuck", value: 0 },
      { metric: "superlog.agent_runs.queued", value: 0 },
      { metric: "superlog.agent_runs.awaiting_human", value: 0 },
      { metric: "superlog.agent_runs.blocked", value: 0 },
      { metric: "superlog.agent_runs.completed_recent", value: 0 },
    );
  }
  if (failedObserved === 0) {
    observations.push({
      metric: "superlog.agent_runs.failed_recent",
      value: 0,
      attributes: { "failure.reason": "none" },
    });
  }
  return observations;
}

let cached: { at: number; counts: AgentRunOrgHealthCounts[] } | null = null;
const CACHE_TTL_MS = 30_000;

async function snapshot(): Promise<AgentRunOrgHealthCounts[]> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.counts;
  const counts = await loadAgentRunHealthCounts();
  cached = { at: Date.now(), counts };
  return counts;
}

export function registerAgentRunHealthMetrics(): void {
  const gauges = {
    "superlog.agent_runs.failed_recent": meter.createObservableGauge(
      "superlog.agent_runs.failed_recent",
      { description: "Agent runs that failed in the last hour, by org and failure.reason." },
    ),
    "superlog.agent_runs.stuck": meter.createObservableGauge("superlog.agent_runs.stuck", {
      description: "Actively-moving agent runs older than 2 hours, by org.",
    }),
    "superlog.agent_runs.queued": meter.createObservableGauge("superlog.agent_runs.queued", {
      description: "Agent runs currently queued, by org.",
    }),
    "superlog.agent_runs.awaiting_human": meter.createObservableGauge(
      "superlog.agent_runs.awaiting_human",
      { description: "Agent runs parked on a human response, by org." },
    ),
    "superlog.agent_runs.blocked": meter.createObservableGauge("superlog.agent_runs.blocked", {
      description: "Agent runs parked on missing prerequisites (e.g. no GitHub connected), by org.",
    }),
    "superlog.agent_runs.completed_recent": meter.createObservableGauge(
      "superlog.agent_runs.completed_recent",
      { description: "Agent runs that completed in the last hour, by org." },
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
