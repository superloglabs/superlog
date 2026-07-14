import type { AgentRunPr, AgentRunResult } from "@superlog/db";

export type DeliveredPullRequestRecord = {
  repoFullName: string;
  branchName: string;
  baseBranch: string;
  title: string | null;
  url: string;
};

export function reconcileDeliveredPullRequests(
  result: AgentRunResult,
  deliveredPullRequests: DeliveredPullRequestRecord[],
): AgentRunResult {
  const proposals = result.prs ?? (result.pr ? [result.pr] : []);
  const prs: AgentRunPr[] = deliveredPullRequests.map((delivered) => {
    const proposal = proposals.find(
      (candidate) => candidate.selectedRepoFullName === delivered.repoFullName,
    );
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
