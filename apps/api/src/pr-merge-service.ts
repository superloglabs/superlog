// Shared manual agent-PR merge flow, used by the dashboard endpoint and Slack
// Merge-PR button. A single PR in a batched delivery is not the Incident's
// resolution boundary: resolve only after every Incident PR is merged.
import { applyAgentPullRequestState, db, schema } from "@superlog/db";
import { eq } from "drizzle-orm";
import {
  type MergedAgentPullRequestContinuationDisposition,
  mergeGithubPullRequest,
  resumeOrResolveIncidentForMergedAgentPr,
} from "./github.js";

export type ManualMergeMethod = "squash" | "merge" | "rebase";
export const VALID_MANUAL_MERGE_METHODS: ReadonlySet<string> = new Set([
  "squash",
  "merge",
  "rebase",
]);

export type ManualAgentPullRequestMergeDisposition =
  | "resolved"
  | "waiting_for_pull_requests"
  | "already_resolved"
  | "continued_in_session";

export type MergeAgentPrOutcome =
  | {
      ok: true;
      sha: string | null;
      pr: schema.AgentPullRequest;
      incidentDisposition: ManualAgentPullRequestMergeDisposition;
    }
  | { ok: false; reason: "pr_not_open" | "installation_unavailable" };

export async function resolveIncidentAfterManualAgentPullRequestMerge(
  opts: {
    pr: schema.AgentPullRequest;
    source: string;
    mergedAt: Date;
  },
  deps: {
    continueOrResolveMergedPullRequest(opts: {
      agentPr: schema.AgentPullRequest;
      mergedAt: Date;
      mergedByLogin: string | null;
      source?: string;
    }): Promise<MergedAgentPullRequestContinuationDisposition>;
  },
): Promise<ManualAgentPullRequestMergeDisposition> {
  const pr = opts.pr;
  const disposition = await deps.continueOrResolveMergedPullRequest({
    agentPr: pr,
    mergedAt: opts.mergedAt,
    mergedByLogin: null,
    source: opts.source,
  });
  if (disposition === "continued_in_session") return disposition;
  if (disposition === "pull_requests_pending") {
    return "waiting_for_pull_requests";
  }
  if (disposition === "incident_not_open") return "already_resolved";
  return "resolved";
}

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
  const mutation = await applyAgentPullRequestState(db, {
    incidentId: pr.incidentId,
    agentPrId: pr.id,
    targetState: "merged",
    observedAt: now,
    mergedAt: now,
    closedAt: now,
    headSha: merged.sha ?? pr.headSha,
  });
  const updatedPr = mutation.pullRequest ?? pr;

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

  const incidentDisposition = await resolveIncidentAfterManualAgentPullRequestMerge(
    {
      pr: updatedPr,
      source: opts.source,
      mergedAt: now,
    },
    {
      continueOrResolveMergedPullRequest: resumeOrResolveIncidentForMergedAgentPr,
    },
  );

  return {
    ok: true,
    sha: merged.sha ?? null,
    pr: updatedPr,
    incidentDisposition,
  };
}
