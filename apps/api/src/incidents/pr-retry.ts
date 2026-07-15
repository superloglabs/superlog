import type { AgentRunResult } from "@superlog/db";
import { agentPullRequestRetryEligibility } from "@superlog/db/agent-pr-retry-domain";

type RetryableAgentRun = {
  state: string;
  failureReason: string | null;
  result: AgentRunResult | null;
};

export type PrDeliveryRetryEligibility = { canRetry: true } | { canRetry: false; reason: string };

export function getPrDeliveryRetryEligibility(
  agentRun: RetryableAgentRun | null,
): PrDeliveryRetryEligibility {
  return agentPullRequestRetryEligibility(agentRun);
}
