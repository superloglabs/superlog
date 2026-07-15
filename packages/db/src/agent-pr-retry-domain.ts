import type { AgentRun, AgentRunResult } from "./schema.js";

type AgentPullRequestRetryCandidate = Pick<AgentRun, "state" | "failureReason"> & {
  result: AgentRunResult | null;
};

export function agentPullRequestRetryEligibility(
  agentRun: AgentPullRequestRetryCandidate | null,
): { canRetry: true } | { canRetry: false; reason: string } {
  if (!agentRun) return { canRetry: false, reason: "agent run not found" };
  if (agentRun.state !== "failed") {
    return { canRetry: false, reason: "agent run is not failed" };
  }
  if (agentRun.failureReason !== "pr_open_failed") {
    return { canRetry: false, reason: "agent run did not fail while opening a PR" };
  }
  const pr = agentRun.result?.pr ?? null;
  if (!pr) return { canRetry: false, reason: "agent run has no PR result" };
  if (pr.openStatus !== "pending") {
    return { canRetry: false, reason: "agent run PR is not pending" };
  }
  if (!pr.selectedRepoFullName) {
    return { canRetry: false, reason: "agent run has no selected repository" };
  }
  if (!pr.baseBranch) {
    return { canRetry: false, reason: "agent run has no base branch" };
  }
  const hasReusablePatch = [pr.patch, pr.patchFileId, pr.patchFilePath].some(
    (value) => typeof value === "string" && value.trim().length > 0,
  );
  if (!hasReusablePatch) {
    return { canRetry: false, reason: "agent run has no reusable patch" };
  }
  return { canRetry: true };
}
