import { and, eq, inArray, isNull } from "drizzle-orm";
import type { DB } from "./client.js";
import * as schema from "./schema.js";

export type IncidentOpenPullRequestToClose = {
  id: string;
  githubInstallationId: number;
  fallbackGithubInstallationIds: number[];
  repoFullName: string;
  prNumber: number;
  prNodeId: string | null;
};

type IncidentOpenPullRequestRow = Omit<
  IncidentOpenPullRequestToClose,
  "fallbackGithubInstallationIds"
> & {
  projectId: string | null;
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
  const rows = (await database
    .select({
      id: schema.agentPullRequests.id,
      projectId: schema.incidents.projectId,
      repoFullName: schema.agentPullRequests.repoFullName,
      prNumber: schema.agentPullRequests.prNumber,
      prNodeId: schema.agentPullRequests.prNodeId,
      githubInstallationId: schema.githubInstallations.installationId,
    })
    .from(schema.agentPullRequests)
    .innerJoin(
      schema.githubInstallations,
      eq(schema.githubInstallations.id, schema.agentPullRequests.installationId),
    )
    .innerJoin(schema.incidents, eq(schema.incidents.id, schema.agentPullRequests.incidentId))
    .where(
      and(
        eq(schema.agentPullRequests.incidentId, opts.incidentId),
        eq(schema.agentPullRequests.state, "open"),
      ),
    )) as IncidentOpenPullRequestRow[];

  const fallbackInstallationIdsByProjectId = await loadFallbackInstallationIdsByProjectId(
    database,
    rows,
  );

  let closedPullRequestCount = 0;
  let failedPullRequestCount = 0;
  for (const row of rows) {
    const { projectId, ...prWithoutProject } = row;
    const fallbackGithubInstallationIds = dedupeInstallationIds(
      fallbackInstallationIdsByProjectId.get(projectId ?? "") ?? [],
    ).filter((installationId) => installationId !== row.githubInstallationId);
    const pr: IncidentOpenPullRequestToClose = {
      ...prWithoutProject,
      fallbackGithubInstallationIds,
    };
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

async function loadFallbackInstallationIdsByProjectId(
  database: DB,
  rows: IncidentOpenPullRequestRow[],
): Promise<Map<string, number[]>> {
  const projectIds = dedupeStrings(rows.map((row) => row.projectId).filter((id) => id !== null));
  const result = new Map<string, number[]>();
  if (projectIds.length === 0) return result;

  const projectInstallations = await database
    .select({
      projectId: schema.githubInstallations.projectId,
      githubInstallationId: schema.githubInstallations.installationId,
    })
    .from(schema.githubInstallations)
    .where(
      and(
        inArray(schema.githubInstallations.projectId, projectIds),
        isNull(schema.githubInstallations.revokedAt),
      ),
    );

  const projectRepoInstallations = await database
    .select({
      projectId: schema.projectGithubRepos.projectId,
      githubInstallationId: schema.githubInstallations.installationId,
    })
    .from(schema.projectGithubRepos)
    .innerJoin(
      schema.githubInstallations,
      eq(schema.githubInstallations.id, schema.projectGithubRepos.installationId),
    )
    .where(
      and(
        inArray(schema.projectGithubRepos.projectId, projectIds),
        isNull(schema.githubInstallations.revokedAt),
      ),
    );

  for (const row of [...projectInstallations, ...projectRepoInstallations]) {
    if (!row.projectId) continue;
    const installationIds = result.get(row.projectId) ?? [];
    installationIds.push(row.githubInstallationId);
    result.set(row.projectId, installationIds);
  }
  return result;
}

function dedupeStrings(values: (string | null)[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (value) seen.add(value);
  }
  return [...seen];
}

function dedupeInstallationIds(values: number[]): number[] {
  const seen = new Set<number>();
  for (const value of values) seen.add(value);
  return [...seen];
}
