import { db, schema } from "@superlog/db";
import { and, count, eq, gte, sql } from "drizzle-orm";

const PULL_REQUEST_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

type AgentPullRequestState = "open" | "closed" | "merged";

type HomeIncidentAggregateRow = {
  day: string;
  severity: string | null;
  count: number | string;
};

export type HomeIncidentTrend = {
  active: number;
  rows: Array<{
    day: string;
    label: string;
    sev1: number;
    sev2: number;
    sev3: number;
    untriaged: number;
  }>;
};

export type AgentPullRequestSummary = {
  window: "30d";
  total: number;
  merged: number;
  unmerged: number;
  open: number;
  closed: number;
};

export function summarizeAgentPullRequestStates(
  rows: Array<{ state: AgentPullRequestState; count: number | string }>,
): AgentPullRequestSummary {
  const counts: Record<AgentPullRequestState, number> = { open: 0, closed: 0, merged: 0 };
  for (const row of rows) counts[row.state] = Number(row.count);

  const unmerged = counts.open + counts.closed;
  return {
    window: "30d",
    total: counts.merged + unmerged,
    merged: counts.merged,
    unmerged,
    open: counts.open,
    closed: counts.closed,
  };
}

export function buildHomeIncidentTrend(
  active: number,
  aggregates: HomeIncidentAggregateRow[],
  now = new Date(),
): HomeIncidentTrend {
  const rows = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(now);
    day.setUTCHours(0, 0, 0, 0);
    day.setUTCDate(day.getUTCDate() - (6 - index));
    return {
      day: day.toISOString().slice(0, 10),
      label: day.toLocaleDateString("en", { weekday: "short", timeZone: "UTC" }),
      sev1: 0,
      sev2: 0,
      sev3: 0,
      untriaged: 0,
    };
  });
  const byDay = new Map(rows.map((row) => [row.day, row]));
  for (const aggregate of aggregates) {
    const row = byDay.get(aggregate.day);
    if (!row) continue;
    const value = Number(aggregate.count);
    if (aggregate.severity === "SEV-1") row.sev1 += value;
    else if (aggregate.severity === "SEV-2") row.sev2 += value;
    else if (aggregate.severity === "SEV-3") row.sev3 += value;
    else row.untriaged += value;
  }
  return { active, rows };
}

export async function getProjectHomeIncidentTrend(
  projectId: string,
  now = new Date(),
): Promise<HomeIncidentTrend> {
  const since = new Date(now);
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - 6);
  const day = sql<string>`to_char(${schema.incidents.firstSeen} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;

  const [activeRows, aggregates] = await Promise.all([
    db
      .select({ count: count() })
      .from(schema.incidents)
      .where(and(eq(schema.incidents.projectId, projectId), eq(schema.incidents.status, "open"))),
    db
      .select({ day, severity: schema.incidents.severity, count: count() })
      .from(schema.incidents)
      .where(and(eq(schema.incidents.projectId, projectId), gte(schema.incidents.firstSeen, since)))
      .groupBy(day, schema.incidents.severity),
  ]);

  return buildHomeIncidentTrend(Number(activeRows[0]?.count ?? 0), aggregates, now);
}

export async function getProjectAgentPullRequestSummary(
  projectId: string,
  now = new Date(),
): Promise<AgentPullRequestSummary> {
  const since = new Date(now.getTime() - PULL_REQUEST_WINDOW_MS);
  const rows = await db
    .select({ state: schema.agentPullRequests.state, count: count() })
    .from(schema.agentPullRequests)
    .innerJoin(schema.incidents, eq(schema.incidents.id, schema.agentPullRequests.incidentId))
    .where(
      and(
        eq(schema.incidents.projectId, projectId),
        gte(schema.agentPullRequests.createdAt, since),
      ),
    )
    .groupBy(schema.agentPullRequests.state);

  return summarizeAgentPullRequestStates(rows);
}
