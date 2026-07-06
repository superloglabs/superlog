// Shared "merge an agent PR and resolve its incident" flow, used by the
// dashboard merge endpoint and the Slack Merge-PR button. GitHub is the source
// of truth for the merge itself; on success we mark the PR row merged, record
// a pr_merged event, and resolve the incident as agent_pr_merged (which also
// marks the incident's issues resolved).
import { db, resolveIncident, schema } from "@superlog/db";
import { eq } from "drizzle-orm";
import { mergeGithubPullRequest } from "./github.js";

export type ManualMergeMethod = "squash" | "merge" | "rebase";
export const VALID_MANUAL_MERGE_METHODS: ReadonlySet<string> = new Set([
  "squash",
  "merge",
  "rebase",
]);

export type MergeAgentPrOutcome =
  | { ok: true; sha: string | null; pr: schema.AgentPullRequest }
  | { ok: false; reason: "pr_not_open" | "installation_unavailable" };

export async function mergeAgentPullRequestAndResolveIncident(opts: {
  pr: schema.AgentPullRequest;
  method: ManualMergeMethod;
  // Rendered into the audit trail: "dashboard" or "slack:<user id>".
  source: string;
}): Promise<MergeAgentPrOutcome> {
  const pr = opts.pr;
  if (pr.state !== "open") return { ok: false, reason: "pr_not_open" };

  const installation = await db.query.githubInstallations.findFirst({
    where: eq(schema.githubInstallations.id, pr.installationId),
  });
  if (!installation || installation.revokedAt) {
    return { ok: false, reason: "installation_unavailable" };
  }

  const merged = await mergeGithubPullRequest({
    installationId: installation.installationId,
    repoFullName: pr.repoFullName,
    prNumber: pr.prNumber,
    method: opts.method,
  });

  const now = new Date();
  const [updatedPr] = await db
    .update(schema.agentPullRequests)
    .set({
      state: "merged",
      mergedAt: now,
      closedAt: now,
      headSha: merged.sha ?? pr.headSha,
      lastSyncedAt: now,
      updatedAt: now,
    })
    .where(eq(schema.agentPullRequests.id, pr.id))
    .returning();

  await db
    .insert(schema.agentPrEvents)
    .values({
      agentPrId: pr.id,
      kind: "pr_merged",
      summary: `PR #${pr.prNumber} merged from ${opts.source}`,
      payload: {
        method: opts.method,
        sha: merged.sha,
        prUrl: pr.url,
        repoFullName: pr.repoFullName,
        source: opts.source,
      },
      providerEventId: `manual_merge:${pr.id}`,
      occurredAt: now,
    })
    .onConflictDoNothing();

  await resolveIncident({
    incidentId: pr.incidentId,
    kind: "agent_pr_merged",
    reasonCode: "agent_pr_merged",
    reasonText: `Resolved because agent PR #${pr.prNumber} (${pr.repoFullName}) was merged (${opts.source}).`,
    agentRunId: pr.agentRunId,
    eventSummary: `Incident resolved because PR #${pr.prNumber} was merged.`,
    eventDetail: {
      agentPrId: pr.id,
      repoFullName: pr.repoFullName,
      prNumber: pr.prNumber,
      prUrl: pr.url,
      source: opts.source,
    },
    eventDedupeKey: `incident_resolved:agent_pr:${pr.id}`,
    resolvedAt: now,
  });

  return { ok: true, sha: merged.sha ?? null, pr: updatedPr ?? pr };
}
