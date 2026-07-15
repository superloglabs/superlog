import { and, asc, desc, eq } from "drizzle-orm";
import { agentPullRequestRetryEligibility } from "./agent-pr-retry-domain.js";
import type { DB } from "./client.js";
import * as schema from "./schema.js";

export type QueueAgentPullRequestRetryResult =
  | { outcome: "queued"; agentRun: schema.AgentRun }
  | { outcome: "incident_not_open" }
  | { outcome: "agent_run_not_latest" }
  | { outcome: "agent_run_not_retryable"; reason: string };

export async function queueAgentPullRequestRetry(
  database: DB,
  input: { incidentId: string; agentRunId: string; now?: Date },
): Promise<QueueAgentPullRequestRetryResult> {
  const now = input.now ?? new Date();
  return database.transaction(async (tx) => {
    const [incident] = await tx
      .select({ id: schema.incidents.id, status: schema.incidents.status })
      .from(schema.incidents)
      .where(eq(schema.incidents.id, input.incidentId))
      .orderBy(asc(schema.incidents.id))
      .for("update");
    if (!incident || incident.status !== "open") return { outcome: "incident_not_open" };

    const runs = await tx
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.incidentId, input.incidentId))
      .orderBy(desc(schema.agentRuns.createdAt), desc(schema.agentRuns.id))
      .for("update");
    const latest = runs[0] ?? null;
    if (latest && latest.id !== input.agentRunId) return { outcome: "agent_run_not_latest" };
    const eligibility = agentPullRequestRetryEligibility(latest);
    if (!eligibility.canRetry) {
      return { outcome: "agent_run_not_retryable", reason: eligibility.reason };
    }

    const [updated] = await tx
      .update(schema.agentRuns)
      .set({
        state: "pr_retry_queued",
        failureReason: null,
        completedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.agentRuns.id, input.agentRunId),
          eq(schema.agentRuns.state, "failed"),
          eq(schema.agentRuns.failureReason, "pr_open_failed"),
        ),
      )
      .returning();
    if (!updated) {
      return {
        outcome: "agent_run_not_retryable",
        reason: "agent run is no longer retryable",
      };
    }

    await tx.insert(schema.incidentEvents).values({
      incidentId: input.incidentId,
      agentRunId: updated.id,
      kind: "agent_run_pr_retry_queued",
      summary: "PR delivery retry queued.",
      detail: {
        retriedFromState: latest?.state ?? null,
        selectedRepoFullName: latest?.result?.pr?.selectedRepoFullName ?? null,
        branchName: latest?.result?.pr?.branchName ?? null,
      },
      dedupeKey: `pr-retry:${updated.id}:${now.getTime()}`,
      processedAt: now,
      createdAt: now,
    });
    return { outcome: "queued", agentRun: updated };
  });
}
