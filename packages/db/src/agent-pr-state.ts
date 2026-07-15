import { and, asc, eq } from "drizzle-orm";
import type { DB } from "./client.js";
import * as schema from "./schema.js";

export type ApplyAgentPullRequestStateInput = {
  incidentId: string;
  agentPrId: string;
  targetState?: schema.AgentPrState;
  observedAt?: Date;
  lastSyncedAt?: Date;
  headSha?: string | null;
  title?: string | null;
  mergedAt?: Date | null;
  closedAt?: Date | null;
  mergedByLogin?: string | null;
  mergedByGithubId?: number | null;
};

export type ApplyAgentPullRequestStateResult = {
  pullRequest: schema.AgentPullRequest | null;
  previousState: schema.AgentPrState | null;
  stateChanged: boolean;
};

export async function applyAgentPullRequestState(
  database: DB,
  input: ApplyAgentPullRequestStateInput,
): Promise<ApplyAgentPullRequestStateResult> {
  const observedAt = input.observedAt ?? new Date();
  return database.transaction(async (tx) => {
    const [incident] = await tx
      .select({ id: schema.incidents.id })
      .from(schema.incidents)
      .where(eq(schema.incidents.id, input.incidentId))
      .orderBy(asc(schema.incidents.id))
      .for("update");
    if (!incident) return { pullRequest: null, previousState: null, stateChanged: false };

    const [current] = await tx
      .select()
      .from(schema.agentPullRequests)
      .where(
        and(
          eq(schema.agentPullRequests.id, input.agentPrId),
          eq(schema.agentPullRequests.incidentId, incident.id),
        ),
      )
      .for("update");
    if (!current) return { pullRequest: null, previousState: null, stateChanged: false };

    const updates: Partial<typeof schema.agentPullRequests.$inferInsert> = {
      lastSyncedAt: input.lastSyncedAt ?? observedAt,
      updatedAt: observedAt,
    };
    if (input.headSha !== undefined) updates.headSha = input.headSha;
    if (input.title !== undefined) updates.title = input.title;

    let stateChanged = false;
    if (input.targetState === "merged") {
      // Merged is terminal and may supersede either an open or an earlier
      // unmerged close. A redelivered merge can still enrich its metadata.
      stateChanged = current.state !== "merged";
      updates.state = "merged";
      if (input.mergedAt !== undefined) updates.mergedAt = input.mergedAt;
      if (input.closedAt !== undefined) {
        updates.closedAt = input.closedAt;
      } else if (stateChanged) {
        updates.closedAt = observedAt;
      }
      if (input.mergedByLogin !== undefined) updates.mergedByLogin = input.mergedByLogin;
      if (input.mergedByGithubId !== undefined) {
        updates.mergedByGithubId = input.mergedByGithubId;
      }
    } else if (input.targetState === "closed" && current.state === "open") {
      stateChanged = true;
      updates.state = "closed";
      if (input.closedAt !== undefined) updates.closedAt = input.closedAt;
    } else if (input.targetState === "open" && current.state === "closed") {
      // A reopened delivery is meaningful only for a prior unmerged close.
      // In particular, it can never reopen a merged PR.
      stateChanged = true;
      updates.state = "open";
      updates.closedAt = null;
    }

    const [updated] = await tx
      .update(schema.agentPullRequests)
      .set(updates)
      .where(eq(schema.agentPullRequests.id, current.id))
      .returning();
    return {
      pullRequest: updated ?? current,
      previousState: current.state,
      stateChanged,
    };
  });
}
