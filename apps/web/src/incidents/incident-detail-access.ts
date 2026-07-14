export type IncidentDetailAccess = {
  canUpdateStatus: boolean;
  canSubmitFeedback: boolean;
  canChat: boolean;
  canDecideResolutionProposal: boolean;
  canMergePullRequest: boolean;
};

export function getIncidentDetailAccess(readOnly: boolean): IncidentDetailAccess {
  const canMutate = !readOnly;
  return {
    canUpdateStatus: canMutate,
    canSubmitFeedback: canMutate,
    canChat: canMutate,
    canDecideResolutionProposal: canMutate,
    canMergePullRequest: canMutate,
  };
}

export function shouldUsePreloadedPullRequests({
  readOnly,
  pullRequestsProvided,
}: {
  readOnly: boolean;
  pullRequestsProvided: boolean;
}): boolean {
  return readOnly || pullRequestsProvided;
}
