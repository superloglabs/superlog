import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { DB } from "./client.js";
import * as schema from "./schema.js";

export type GithubAccessUnblockTrigger = "github_install" | "github_repos_added";

export async function unblockAgentRunsAfterGithubAccess(
  database: DB,
  input: {
    projectIds: string[];
    trigger: GithubAccessUnblockTrigger;
    now?: Date;
  },
): Promise<{ unblockedCount: number }> {
  const projectIds = [...new Set(input.projectIds)].sort();
  if (projectIds.length === 0) return { unblockedCount: 0 };
  const now = input.now ?? new Date();

  return database.transaction(async (tx) => {
    // The Incident is the aggregate root for investigation state. Lock every
    // candidate in a stable order before touching its AgentRuns so GitHub
    // access changes serialize with resolution, restart, and follow-up work.
    const incidents = await tx
      .select({ id: schema.incidents.id, status: schema.incidents.status })
      .from(schema.incidents)
      .where(
        and(
          inArray(schema.incidents.projectId, projectIds),
          sql`exists (
            select 1 from ${schema.agentRuns}
            where ${schema.agentRuns.incidentId} = ${schema.incidents.id}
              and ${schema.agentRuns.state} = 'blocked_no_github'
          )`,
        ),
      )
      .orderBy(asc(schema.incidents.id))
      .for("update");
    const openIncidentIds = incidents
      .filter((incident) => incident.status === "open")
      .map((incident) => incident.id);
    if (openIncidentIds.length === 0) return { unblockedCount: 0 };

    const unblocked = await tx
      .update(schema.agentRuns)
      .set({ state: "queued", updatedAt: now })
      .where(
        and(
          inArray(schema.agentRuns.incidentId, openIncidentIds),
          eq(schema.agentRuns.state, "blocked_no_github"),
        ),
      )
      .returning({ id: schema.agentRuns.id, incidentId: schema.agentRuns.incidentId });
    if (unblocked.length === 0) return { unblockedCount: 0 };

    await tx
      .insert(schema.incidentEvents)
      .values(
        unblocked.map((run) => ({
          incidentId: run.incidentId,
          agentRunId: run.id,
          kind: "unblocked",
          summary: "Investigation requeued.",
          detail: { trigger: input.trigger },
          dedupeKey: `unblocked:${run.id}:${now.getTime()}`,
          processedAt: now,
          createdAt: now,
        })),
      )
      .onConflictDoNothing();
    return { unblockedCount: unblocked.length };
  });
}
