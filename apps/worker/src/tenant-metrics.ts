import { metrics } from "@opentelemetry/api";
import { db, schema } from "@superlog/db";
import { eq, isNull, sql } from "drizzle-orm";
import { logger } from "./logger.js";

const meter = metrics.getMeter("@superlog/worker/tenant");

const SELF_ORG_IDS = new Set(
  (process.env.SUPERLOG_SELF_ORG_ID ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

type OrgRow = { id: string; name: string };

async function listOrgs(): Promise<OrgRow[]> {
  const rows = await db
    .select({ id: schema.orgs.id, name: schema.orgs.name })
    .from(schema.orgs)
    .innerJoin(schema.projects, eq(schema.projects.orgId, schema.orgs.id))
    .groupBy(schema.orgs.id, schema.orgs.name);
  return rows.filter((r) => !SELF_ORG_IDS.has(r.id));
}

type Counts = {
  issuesOpen: Map<string, number>;
  incidentsOpen: Map<string, number>;
  prsOpen: Map<string, number>;
  prsMergedTotal: Map<string, number>;
};

async function loadCounts(): Promise<Counts> {
  const issuesOpen = new Map<string, number>();
  const incidentsOpen = new Map<string, number>();
  const prsOpen = new Map<string, number>();
  const prsMergedTotal = new Map<string, number>();

  const issueRows = await db
    .select({ orgId: schema.projects.orgId, c: sql<number>`count(*)::int` })
    .from(schema.issues)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.issues.projectId))
    .where(isNull(schema.issues.silencedAt))
    .groupBy(schema.projects.orgId);
  for (const r of issueRows) issuesOpen.set(r.orgId, Number(r.c));

  const incidentRows = await db
    .select({ orgId: schema.projects.orgId, c: sql<number>`count(*)::int` })
    .from(schema.incidents)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.incidents.projectId))
    .where(eq(schema.incidents.status, "open"))
    .groupBy(schema.projects.orgId);
  for (const r of incidentRows) incidentsOpen.set(r.orgId, Number(r.c));

  // agent_pull_requests links to incidents → projects → orgs
  const prOpenRows = await db
    .select({ orgId: schema.projects.orgId, c: sql<number>`count(*)::int` })
    .from(schema.agentPullRequests)
    .innerJoin(schema.incidents, eq(schema.incidents.id, schema.agentPullRequests.incidentId))
    .innerJoin(schema.projects, eq(schema.projects.id, schema.incidents.projectId))
    .where(eq(schema.agentPullRequests.state, "open"))
    .groupBy(schema.projects.orgId);
  for (const r of prOpenRows) prsOpen.set(r.orgId, Number(r.c));

  const prMergedRows = await db
    .select({ orgId: schema.projects.orgId, c: sql<number>`count(*)::int` })
    .from(schema.agentPullRequests)
    .innerJoin(schema.incidents, eq(schema.incidents.id, schema.agentPullRequests.incidentId))
    .innerJoin(schema.projects, eq(schema.projects.id, schema.incidents.projectId))
    .where(eq(schema.agentPullRequests.state, "merged"))
    .groupBy(schema.projects.orgId);
  for (const r of prMergedRows) prsMergedTotal.set(r.orgId, Number(r.c));

  return { issuesOpen, incidentsOpen, prsOpen, prsMergedTotal };
}

let cached: { at: number; orgs: OrgRow[]; counts: Counts } | null = null;
const CACHE_TTL_MS = 30_000;

async function snapshot(): Promise<{ orgs: OrgRow[]; counts: Counts }> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { orgs: cached.orgs, counts: cached.counts };
  }
  const [orgs, counts] = await Promise.all([listOrgs(), loadCounts()]);
  cached = { at: Date.now(), orgs, counts };
  return { orgs, counts };
}

export function registerTenantMetrics(): void {
  const issuesGauge = meter.createObservableGauge("superlog.tenant.issues.open", {
    description: "Active (non-silenced) issues per tenant org.",
  });
  const incidentsGauge = meter.createObservableGauge("superlog.tenant.incidents.open", {
    description: "Open incidents (status='open') per tenant org.",
  });
  const prsOpenGauge = meter.createObservableGauge("superlog.tenant.prs.open", {
    description: "Agent pull requests in state='open' per tenant org.",
  });
  const prsMergedGauge = meter.createObservableGauge("superlog.tenant.prs.merged_total", {
    description: "Cumulative agent pull requests ever merged, per tenant org.",
  });

  meter.addBatchObservableCallback(
    async (result) => {
      try {
        const { orgs, counts } = await snapshot();
        for (const org of orgs) {
          const attrs = { "tenant.org.id": org.id, "tenant.org.name": org.name };
          result.observe(issuesGauge, counts.issuesOpen.get(org.id) ?? 0, attrs);
          result.observe(incidentsGauge, counts.incidentsOpen.get(org.id) ?? 0, attrs);
          result.observe(prsOpenGauge, counts.prsOpen.get(org.id) ?? 0, attrs);
          result.observe(prsMergedGauge, counts.prsMergedTotal.get(org.id) ?? 0, attrs);
        }
      } catch (err) {
        logger.error({ err, scope: "tenant-metrics" }, "tenant metrics observe failed");
      }
    },
    [issuesGauge, incidentsGauge, prsOpenGauge, prsMergedGauge],
  );
}
