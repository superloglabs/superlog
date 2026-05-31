import type { ClickHouseClient } from "@clickhouse/client";
import { type DB, schema } from "@superlog/db";
import { sql } from "drizzle-orm";
import type { OrgSnapshot, OrgTraceMetrics, UserOrgMembership, UserSnapshot } from "./domain.js";
import type { AttioRepository } from "./sync.js";

type OrgRow = {
  id: string;
  name: string;
  slug: string;
  created_at: Date | string;
  member_count: number | string;
  project_count: number | string;
  owner_email: string | null;
  member_emails: string[] | null;
  github_connected: boolean;
  slack_connected: boolean;
  mcp_connected: boolean;
  prs_opened_last_week: number | string;
  prs_merged_last_week: number | string;
  project_ids: string[] | null;
};

type UserRow = {
  id: string;
  email: string;
  name: string;
  created_at: Date | string;
  memberships: UserOrgMembership[] | string | null;
};

type TraceRow = {
  project_id: string;
  traces_last_week: number | string;
  span_rows_last_week: number | string;
};

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function memberships(value: UserRow["memberships"]): UserOrgMembership[] {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  return JSON.parse(value) as UserOrgMembership[];
}

export function createAttioRepository(options: {
  db: DB;
  clickhouse: Pick<ClickHouseClient, "query">;
}): AttioRepository {
  return {
    async loadOrgSnapshots(): Promise<OrgSnapshot[]> {
      const rows = await options.db.execute<OrgRow>(sql`
        SELECT
          o.id::text,
          o.name,
          o.slug,
          o.created_at,
          (
            SELECT count(*)::int
            FROM org_members m
            WHERE m.org_id = o.id
          ) AS member_count,
          (
            SELECT count(*)::int
            FROM projects p
            WHERE p.org_id = o.id
          ) AS project_count,
          (
            SELECT lower(u.email)
            FROM org_members m
            JOIN users u ON u.id = m.user_id
            WHERE m.org_id = o.id
            ORDER BY CASE WHEN m.role = 'owner' THEN 0 ELSE 1 END, u.created_at, u.email
            LIMIT 1
          ) AS owner_email,
          (
            SELECT coalesce(array_agg(DISTINCT lower(u.email) ORDER BY lower(u.email)), ARRAY[]::text[])
            FROM org_members m
            JOIN users u ON u.id = m.user_id
            WHERE m.org_id = o.id
          ) AS member_emails,
          EXISTS (
            SELECT 1
            FROM github_installations gh
            WHERE gh.org_id = o.id
              AND gh.revoked_at IS NULL
          ) AS github_connected,
          EXISTS (
            SELECT 1
            FROM slack_installations s
            JOIN projects p ON p.id = s.project_id
            WHERE p.org_id = o.id
              AND s.revoked_at IS NULL
          ) AS slack_connected,
          EXISTS (
            SELECT 1
            FROM mcp_oauth_tokens t
            JOIN projects p ON p.id = t.project_id
            WHERE p.org_id = o.id
              AND t.revoked_at IS NULL
          ) AS mcp_connected,
          (
            SELECT count(*)::int
            FROM agent_pull_requests pr
            JOIN github_installations gh ON gh.id = pr.installation_id
            WHERE gh.org_id = o.id
              AND pr.created_at > now() - INTERVAL '7 days'
          ) AS prs_opened_last_week,
          (
            SELECT count(*)::int
            FROM agent_pull_requests pr
            JOIN github_installations gh ON gh.id = pr.installation_id
            WHERE gh.org_id = o.id
              AND pr.merged_at > now() - INTERVAL '7 days'
          ) AS prs_merged_last_week,
          (
            SELECT coalesce(array_agg(p.id::text ORDER BY p.id::text), ARRAY[]::text[])
            FROM projects p
            WHERE p.org_id = o.id
          ) AS project_ids
        FROM orgs o
        ORDER BY lower(coalesce(o.name, '')), o.created_at, o.id
      `);

      return (rows as unknown as OrgRow[]).map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        createdAt: iso(row.created_at),
        memberCount: Number(row.member_count),
        projectCount: Number(row.project_count),
        ownerEmail: row.owner_email,
        memberEmails: row.member_emails ?? [],
        githubConnected: row.github_connected,
        slackConnected: row.slack_connected,
        mcpConnected: row.mcp_connected,
        prsOpenedLastWeek: Number(row.prs_opened_last_week),
        prsMergedLastWeek: Number(row.prs_merged_last_week),
        projectIds: row.project_ids ?? [],
      }));
    },

    async loadUserSnapshots(): Promise<UserSnapshot[]> {
      const rows = await options.db.execute<UserRow>(sql`
        SELECT
          u.id::text,
          lower(u.email) AS email,
          u.name,
          u.created_at,
          (
            SELECT coalesce(json_agg(json_build_object(
              'orgId', o.id::text,
              'orgName', o.name,
              'role', m.role
            ) ORDER BY lower(o.name), o.id::text), '[]'::json)
            FROM org_members m
            JOIN orgs o ON o.id = m.org_id
            WHERE m.user_id = u.id
          ) AS memberships
        FROM users u
        WHERE u.email IS NOT NULL
          AND u.email <> ''
        ORDER BY lower(u.email)
      `);

      return (rows as unknown as UserRow[]).map((row) => ({
        id: row.id,
        email: row.email,
        name: row.name,
        createdAt: iso(row.created_at),
        memberships: memberships(row.memberships),
      }));
    },

    async loadTraceMetricsByOrgId(orgs: OrgSnapshot[]): Promise<Map<string, OrgTraceMetrics>> {
      const projectToOrgId = new Map<string, string>();
      for (const org of orgs) {
        for (const projectId of org.projectIds) projectToOrgId.set(projectId, org.id);
      }
      const projectIds = [...projectToOrgId.keys()];
      const byOrg = new Map<string, OrgTraceMetrics>();
      if (projectIds.length === 0) return byOrg;

      const result = await options.clickhouse.query({
        query: `
          SELECT
            ResourceAttributes['superlog.project_id'] AS project_id,
            uniqExact(TraceId) AS traces_last_week,
            count() AS span_rows_last_week
          FROM otel_traces
          WHERE Timestamp > now() - INTERVAL 7 DAY
            AND has({projectIds:Array(String)}, ResourceAttributes['superlog.project_id'])
          GROUP BY project_id
        `,
        query_params: { projectIds },
        format: "JSONEachRow",
      });
      const rows = (await result.json()) as TraceRow[];
      for (const row of rows) {
        const orgId = projectToOrgId.get(row.project_id);
        if (!orgId) continue;
        const current = byOrg.get(orgId) ?? { tracesLastWeek: 0, spanRowsLastWeek: 0 };
        current.tracesLastWeek += Number(row.traces_last_week);
        current.spanRowsLastWeek += Number(row.span_rows_last_week);
        byOrg.set(orgId, current);
      }
      return byOrg;
    },
  };
}

export { schema };
