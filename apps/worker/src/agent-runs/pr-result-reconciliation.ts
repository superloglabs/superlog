import type { AgentRunPr, AgentRunResult, schema } from "@superlog/db";

export type DeliveredPullRequestRecord = {
  id?: string;
  agentRunId?: string;
  repoFullName: string;
  branchName: string;
  baseBranch: string;
  title: string | null;
  url: string;
  state?: schema.AgentPrState;
  createdAt?: Date;
};

function isCollisionFallbackBranch(requested: string, actual: string): boolean {
  return actual.startsWith(`${requested}-retry-`);
}

function proposalAssignments(
  proposals: AgentRunPr[],
  deliveredPullRequests: DeliveredPullRequestRecord[],
  currentAgentRunId: string | undefined,
): Map<number, number> {
  const assignments = new Map<number, number>();
  const unmatchedProposals = new Set(proposals.map((_, index) => index));

  const assignMatches = (args: {
    sameRunOnly: boolean;
    branchMatches: (requested: string, actual: string) => boolean;
  }) => {
    for (const proposalIndex of [...unmatchedProposals]) {
      const proposal = proposals[proposalIndex];
      if (!proposal) continue;
      const matchingDeliveryIndexes = deliveredPullRequests.flatMap((delivered, index) => {
        if (assignments.has(index)) return [];
        if (delivered.repoFullName !== proposal.selectedRepoFullName) return [];
        if (args.sameRunOnly && delivered.agentRunId !== currentAgentRunId) return [];
        return args.branchMatches(proposal.branchName, delivered.branchName) ? [index] : [];
      });
      // Sync supplies canonical rows oldest-first. Prefer the latest matching
      // delivery so a durable run that reuses a requested branch after an old
      // PR closed attaches its proposal context to the collision-renamed PR.
      const deliveryIndex = matchingDeliveryIndexes.at(-1);
      if (deliveryIndex === undefined) continue;
      assignments.set(deliveryIndex, proposalIndex);
      unmatchedProposals.delete(proposalIndex);
    }
  };

  const assignUniqueRepositoryMatches = (sameRunOnly: boolean) => {
    for (const proposalIndex of [...unmatchedProposals]) {
      const proposal = proposals[proposalIndex];
      if (!proposal) continue;
      const proposalCount = [...unmatchedProposals].filter(
        (index) => proposals[index]?.selectedRepoFullName === proposal.selectedRepoFullName,
      ).length;
      if (proposalCount !== 1) continue;
      const deliveryIndexes = deliveredPullRequests.flatMap((delivered, index) => {
        if (assignments.has(index)) return [];
        if (delivered.repoFullName !== proposal.selectedRepoFullName) return [];
        if (sameRunOnly && delivered.agentRunId !== currentAgentRunId) return [];
        return [index];
      });
      const deliveryIndex = deliveryIndexes[0];
      if (deliveryIndexes.length !== 1 || deliveryIndex === undefined) continue;
      assignments.set(deliveryIndex, proposalIndex);
      unmatchedProposals.delete(proposalIndex);
    }
  };

  const requestedOrCollisionBranch = (requested: string, actual: string) =>
    requested === actual || isCollisionFallbackBranch(requested, actual);
  if (currentAgentRunId) {
    assignMatches({ sameRunOnly: true, branchMatches: requestedOrCollisionBranch });
    assignUniqueRepositoryMatches(true);
  }
  assignMatches({ sameRunOnly: false, branchMatches: requestedOrCollisionBranch });
  assignUniqueRepositoryMatches(false);

  return assignments;
}

export function selectDeliveredPullRequestsForOutcome<T extends DeliveredPullRequestRecord>(
  result: AgentRunResult,
  deliveredPullRequests: T[],
  currentAgentRunId: string,
  opts: { deliveryReceiptUrls?: readonly string[] } = {},
): T[] {
  const proposals = result.prs ?? (result.pr ? [result.pr] : []);
  const declaredUrls = new Set([
    ...proposals.flatMap((proposal) => (proposal.url ? [proposal.url] : [])),
    ...(proposals.length > 0 ? (opts.deliveryReceiptUrls ?? []) : []),
  ]);
  if (declaredUrls.size > 0) {
    return deliveredPullRequests.filter((delivery) => declaredUrls.has(delivery.url));
  }

  // Durable results created before delivery URLs were attached can still be
  // reconciled safely through one-to-one proposal assignments. Prefer rows
  // owned by this run, then match any remaining proposals by their coordinates
  // because an update to an older open PR keeps that row's original run id.
  const assignments = proposalAssignments(proposals, deliveredPullRequests, currentAgentRunId);
  return [...assignments.entries()]
    .sort(([, leftProposalIndex], [, rightProposalIndex]) => leftProposalIndex - rightProposalIndex)
    .flatMap(([deliveryIndex]) => {
      const delivery = deliveredPullRequests[deliveryIndex];
      return delivery ? [delivery] : [];
    });
}

export function reconcileDeliveredPullRequests(
  result: AgentRunResult,
  deliveredPullRequests: DeliveredPullRequestRecord[],
  opts: { currentAgentRunId?: string } = {},
): AgentRunResult {
  const proposals = result.prs ?? (result.pr ? [result.pr] : []);
  const assignments = proposalAssignments(proposals, deliveredPullRequests, opts.currentAgentRunId);
  const prs: AgentRunPr[] = deliveredPullRequests.map((delivered, index) => {
    const proposalIndex = assignments.get(index);
    const proposal = proposalIndex === undefined ? undefined : proposals[proposalIndex];
    return {
      ...(proposal ?? {}),
      selectedRepoFullName: delivered.repoFullName,
      branchName: delivered.branchName,
      baseBranch: delivered.baseBranch,
      title: delivered.title,
      openStatus: "opened",
      url: delivered.url,
    };
  });

  return {
    ...result,
    prs: prs.length > 0 ? prs : null,
    pr: prs.at(-1) ?? null,
  };
}
