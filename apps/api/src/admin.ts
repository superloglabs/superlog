import type { ClickHouseClient } from "@clickhouse/client";
import { db, schema } from "@superlog/db";
import { eq, gte, isNull, sql } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { loadEvalsOverview, loadInvestigationFixtureDetail } from "./admin-evals.js";
import {
  type AdminOrgOverviewRow,
  type AdminOverviewSources,
  adminTraceIngestBucketsQuery,
  buildAdminOrgOverview,
} from "./admin-overview.js";
import { logger } from "./logger.js";

type Vars = { userId: string; orgId: string | null };

export type { AdminOrgOverviewRow };
export type {
  AdminEvalsOverview,
  IncidentEvalFixture,
  InvestigationEvalFixture,
  InvestigationEvalDetail,
} from "./admin-evals.js";

// Staff is anyone whose user row has "admin" in the Better Auth admin
// plugin's `role` column (comma-separated list). Grant/revoke at runtime
// via SQL or `authClient.admin.setRole` — no redeploy required.
export function userIsStaff(role: string | null | undefined): boolean {
  if (!role) return false;
  return role.split(",").some((r) => r.trim() === "admin");
}

async function isStaff(userId: string): Promise<boolean> {
  const user = await db.query.users.findFirst({ where: eq(schema.users.id, userId) });
  // Banned admins lose access here too — Better Auth's session middleware
  // already gates banned users, but defense-in-depth in case that gate is
  // ever bypassed or misconfigured.
  if (!user || user.banned) return false;
  return userIsStaff(user.role);
}

export function mountAdmin(app: Hono<{ Variables: Vars }>, opts: { ch: ClickHouseClient }) {
  const requireAdmin = async (c: Context<{ Variables: Vars }>) => {
    if (!(await isStaff(c.var.userId))) {
      throw new HTTPException(403, { message: "admin access required" });
    }
  };

  app.get("/api/admin/org-overview", async (c) => {
    await requireAdmin(c);

    const now = new Date();
    const thisWeekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const prevWeekStart = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    const thisWeekStartIso = thisWeekStart.toISOString();
    const prevWeekStartIso = prevWeekStart.toISOString();

    const sources: AdminOverviewSources = {
      loadOrgs: () =>
        db
          .select({
            id: schema.orgs.id,
            name: schema.orgs.name,
            slug: schema.orgs.slug,
            createdAt: schema.orgs.createdAt,
            signupSource: schema.orgs.signupSource,
          })
          .from(schema.orgs),
      loadGithubConnections: () =>
        db
          .select({
            orgId: schema.githubInstallations.orgId,
            connectedAt: sql<Date>`min(${schema.githubInstallations.createdAt})`,
          })
          .from(schema.githubInstallations)
          .where(isNull(schema.githubInstallations.revokedAt))
          .groupBy(schema.githubInstallations.orgId),
      loadSlackConnections: () =>
        db
          .select({
            orgId: schema.projects.orgId,
            connectedAt: sql<Date>`min(${schema.slackInstallations.createdAt})`,
          })
          .from(schema.slackInstallations)
          .innerJoin(schema.projects, eq(schema.projects.id, schema.slackInstallations.projectId))
          .where(isNull(schema.slackInstallations.revokedAt))
          .groupBy(schema.projects.orgId),
      loadMcpConnections: () =>
        db
          .select({
            orgId: schema.projects.orgId,
            connectedAt: sql<Date>`min(${schema.mcpOauthTokens.createdAt})`,
          })
          .from(schema.mcpOauthTokens)
          .innerJoin(schema.projects, eq(schema.projects.id, schema.mcpOauthTokens.projectId))
          .where(isNull(schema.mcpOauthTokens.revokedAt))
          .groupBy(schema.projects.orgId),
      loadIncidentBuckets: () =>
        db
          .select({
            orgId: schema.projects.orgId,
            thisWeek: sql<number>`count(*) filter (where ${schema.incidents.createdAt} >= ${thisWeekStartIso})::int`,
            prevWeek: sql<number>`count(*) filter (where ${schema.incidents.createdAt} >= ${prevWeekStartIso} and ${schema.incidents.createdAt} < ${thisWeekStartIso})::int`,
          })
          .from(schema.incidents)
          .innerJoin(schema.projects, eq(schema.projects.id, schema.incidents.projectId))
          .where(gte(schema.incidents.createdAt, prevWeekStart))
          .groupBy(schema.projects.orgId),
      loadPrOpenedBuckets: () =>
        db
          .select({
            orgId: schema.githubInstallations.orgId,
            thisWeek: sql<number>`count(*) filter (where ${schema.agentPullRequests.createdAt} >= ${thisWeekStartIso})::int`,
            prevWeek: sql<number>`count(*) filter (where ${schema.agentPullRequests.createdAt} >= ${prevWeekStartIso} and ${schema.agentPullRequests.createdAt} < ${thisWeekStartIso})::int`,
          })
          .from(schema.agentPullRequests)
          .innerJoin(
            schema.githubInstallations,
            eq(schema.githubInstallations.id, schema.agentPullRequests.installationId),
          )
          .where(gte(schema.agentPullRequests.createdAt, prevWeekStart))
          .groupBy(schema.githubInstallations.orgId),
      loadPrMergedBuckets: () =>
        db
          .select({
            orgId: schema.githubInstallations.orgId,
            thisWeek: sql<number>`count(*) filter (where ${schema.agentPullRequests.mergedAt} >= ${thisWeekStartIso})::int`,
            prevWeek: sql<number>`count(*) filter (where ${schema.agentPullRequests.mergedAt} >= ${prevWeekStartIso} and ${schema.agentPullRequests.mergedAt} < ${thisWeekStartIso})::int`,
          })
          .from(schema.agentPullRequests)
          .innerJoin(
            schema.githubInstallations,
            eq(schema.githubInstallations.id, schema.agentPullRequests.installationId),
          )
          .where(gte(schema.agentPullRequests.mergedAt, prevWeekStart))
          .groupBy(schema.githubInstallations.orgId),
      loadTraceBuckets: async (signal) => {
        const r = await opts.ch.query({
          query: adminTraceIngestBucketsQuery(),
          abort_signal: signal,
          format: "JSONEachRow",
        });
        const rows = (await r.json()) as {
          org_id: string;
          this_week: string | number;
          prev_week: string | number;
        }[];
        return rows.map((row) => ({
          orgId: row.org_id,
          thisWeek: Number(row.this_week),
          prevWeek: Number(row.prev_week),
        }));
      },
      loadMembers: () =>
        db
          .select({
            orgId: schema.orgMembers.orgId,
            userId: schema.users.id,
            email: schema.users.email,
            name: schema.users.name,
            joinedAt: schema.orgMembers.createdAt,
          })
          .from(schema.orgMembers)
          .innerJoin(schema.users, eq(schema.users.id, schema.orgMembers.userId)),
    };

    const result = await buildAdminOrgOverview(sources, {
      onTraceTelemetryUnavailable: (reason, err) => {
        logger.warn({ err, reason }, "admin org overview trace telemetry unavailable");
      },
    });

    return c.json(result);
  });

  app.get("/api/admin/evals", async (c) => {
    await requireAdmin(c);
    return c.json(loadEvalsOverview());
  });

  app.get("/api/admin/evals/investigations/:slug", async (c) => {
    await requireAdmin(c);
    const detail = loadInvestigationFixtureDetail(c.req.param("slug"));
    if (!detail) throw new HTTPException(404, { message: "investigation fixture not found" });
    return c.json(detail);
  });
}
