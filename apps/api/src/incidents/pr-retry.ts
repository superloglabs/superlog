import type { AgentRunResult } from "@superlog/db";

type RetryableAgentRun = {
  state: string;
  failureReason: string | null;
  result: AgentRunResult | null;
};

export type PrDeliveryRetryEligibility = { canRetry: true } | { canRetry: false; reason: string };

export function getPrDeliveryRetryEligibility(
  agentRun: RetryableAgentRun | null,
): PrDeliveryRetryEligibility {
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
  if (!hasReusablePatch(pr)) {
    return { canRetry: false, reason: "agent run has no reusable patch" };
  }

  return { canRetry: true };
}

function hasReusablePatch(pr: AgentRunResult["pr"]): boolean {
  if (!pr) return false;
  if (typeof pr.patch === "string" && pr.patch.trim().length > 0) return true;
  if (typeof pr.patchFileId === "string" && pr.patchFileId.trim().length > 0) return true;
  if (typeof pr.patchFilePath === "string" && pr.patchFilePath.trim().length > 0) return true;
  return false;
}
