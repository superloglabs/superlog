import { and, eq } from "drizzle-orm";
import type { DB } from "./client.js";
import * as schema from "./schema.js";

export type IncidentOpenPullRequestToClose = {
  id: string;
  githubInstallationId: number;
  repoFullName: string;
  prNumber: number;
};

export type CloseIncidentPullRequest = (
  pr: IncidentOpenPullRequestToClose,
) => Promise<{ ok: true } | { ok: false; error: string }>;

export type CloseIncidentOpenPullRequestsResult = {
  closedPullRequestCount: number;
  failedPullRequestCount: number;
};

export async function closeIncidentOpenPullRequestsAfterResolution(opts: {
  incidentId: string;
  closePullRequest: CloseIncidentPullRequest;
  database?: DB;
  now?: () => Date;
  onCloseFailure?: (input: { pr: IncidentOpenPullRequestToClose; error: string }) => void;
}): Promise<CloseIncidentOpenPullRequestsResult> {
  const database = opts.database ?? (await import("./client.js")).db;
  const now = opts.now ?? (() => new Date());
  const rows = await database
    .select({
      id: schema.agentPullRequests.id,
      repoFullName: schema.agentPullRequests.repoFullName,
      prNumber: schema.agentPullRequests.prNumber,
      githubInstallationId: schema.githubInstallations.installationId,
    })
    .from(schema.agentPullRequests)
    .innerJoin(
      schema.githubInstallations,
      eq(schema.githubInstallations.id, schema.agentPullRequests.installationId),
    )
    .where(
      and(
        eq(schema.agentPullRequests.incidentId, opts.incidentId),
        eq(schema.agentPullRequests.state, "open"),
      ),
    );

  let closedPullRequestCount = 0;
  let failedPullRequestCount = 0;
  for (const pr of rows) {
    const closedAt = now();
    const result = await opts.closePullRequest(pr);
    if (!result.ok) {
      failedPullRequestCount += 1;
      opts.onCloseFailure?.({ pr, error: result.error });
      continue;
    }

    await database
      .update(schema.agentPullRequests)
      .set({
        state: "closed",
        closedAt,
        lastSyncedAt: closedAt,
        updatedAt: closedAt,
      })
      .where(
        and(eq(schema.agentPullRequests.id, pr.id), eq(schema.agentPullRequests.state, "open")),
      );
    await database
      .insert(schema.agentPrEvents)
      .values({
        agentPrId: pr.id,
        kind: "pr_closed",
        summary: `Closed PR #${pr.prNumber} because the incident was resolved.`,
        payload: { repoFullName: pr.repoFullName, prNumber: pr.prNumber },
        providerEventId: `pr_closed:incident_resolved:${pr.id}`,
        occurredAt: closedAt,
      })
      .onConflictDoNothing();
    closedPullRequestCount += 1;
  }

  return { closedPullRequestCount, failedPullRequestCount };
}
