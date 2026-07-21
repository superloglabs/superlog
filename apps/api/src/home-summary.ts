import { db, schema } from "@superlog/db";
import { and, count, eq, gte } from "drizzle-orm";

const PULL_REQUEST_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

type AgentPullRequestState = "open" | "closed" | "merged";

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
