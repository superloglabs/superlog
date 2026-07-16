import type { AgentPrState, AgentRunFollowUpInteraction } from "./schema.js";

// A merged PR is sufficient to resolve only when it represents the complete
// Incident delivery. Keep this incident-wide rule shared by webhook, manual
// merge, and worker recovery paths so batched PRs cannot drift semantically.
export function areAllIncidentPullRequestsMerged(
  pullRequests: Array<{ state: AgentPrState }>,
): boolean {
  return (
    pullRequests.length > 0 && pullRequests.every((pullRequest) => pullRequest.state === "merged")
  );
}

// A closed PR resolves the incident only once no delivery is still in play:
// every incident PR must be settled (merged or closed). A human closing the
// last live PR is their decision on the delivery itself — the incident
// resolves rather than waiting for a confirmation nobody sends. Shared by the
// webhook and worker recovery paths, like the merged predicate above.
export function areAllIncidentPullRequestsSettled(
  pullRequests: Array<{ state: AgentPrState }>,
): boolean {
  return (
    pullRequests.length > 0 && pullRequests.every((pullRequest) => pullRequest.state !== "open")
  );
}

export type AgentPullRequestLifecycleRecord = {
  id: string;
  state: AgentPrState;
  url: string;
  repoFullName: string;
  branchName: string;
  prNumber: number;
  mergedAt: Date | null;
  closedAt: Date | null;
  mergedByLogin: string | null;
};

export type AgentPullRequestLifecycleContinuation = {
  interaction: Omit<AgentRunFollowUpInteraction, "channel"> & {
    channel: "pr_merged" | "pr_closed";
  };
  dedupeKey: string;
};

export function buildAgentPullRequestLifecycleContinuation(args: {
  pullRequest: AgentPullRequestLifecycleRecord;
  actorLogin?: string | null;
  occurredAt?: Date;
  fallbackOccurredAt?: Date;
}): AgentPullRequestLifecycleContinuation | null {
  const { pullRequest } = args;
  if (pullRequest.state === "open") return null;

  const recordedAt =
    args.occurredAt ??
    (pullRequest.state === "merged" ? pullRequest.mergedAt : pullRequest.closedAt);
  const occurredAt = recordedAt ?? args.fallbackOccurredAt;
  if (!occurredAt) {
    throw new Error(`Missing lifecycle timestamp for ${pullRequest.state} pull request`);
  }
  const actorLogin =
    args.actorLogin !== undefined
      ? args.actorLogin
      : pullRequest.state === "merged"
        ? pullRequest.mergedByLogin
        : null;

  if (pullRequest.state === "merged") {
    return {
      interaction: {
        channel: "pr_merged",
        agentPrId: pullRequest.id,
        author: actorLogin,
        text: `Your PR #${pullRequest.prNumber} (${pullRequest.repoFullName}, branch \`${pullRequest.branchName}\`) was merged${
          actorLogin ? ` by @${actorLogin}` : ""
        }. If this completes the remediation, make sure every linked issue is classified and call resolve_incident; if more work remains (other PRs still open, issues unclassified), continue it.`,
        url: pullRequest.url,
        occurredAt: occurredAt.toISOString(),
      },
      dedupeKey: `agent_pr_merged:${pullRequest.id}`,
    };
  }

  return {
    interaction: {
      channel: "pr_closed",
      agentPrId: pullRequest.id,
      author: actorLogin,
      text: `Your PR #${pullRequest.prNumber} (${pullRequest.repoFullName}, branch \`${pullRequest.branchName}\`) was closed without being merged${
        actorLogin ? ` by @${actorLogin}` : ""
      }. Read the PR conversation for the close context: if it shows the incident is actually noise, classify the issues accordingly and call resolve_incident; if the fix is still needed, decide the next step (an adjusted PR, or ask_human).`,
      url: pullRequest.url,
      occurredAt: occurredAt.toISOString(),
    },
    dedupeKey: `agent_pr_closed:${pullRequest.id}:${recordedAt?.getTime() ?? "recovered"}`,
  };
}
