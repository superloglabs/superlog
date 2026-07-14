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

// The product detail passes preloaded PRs too (tab visibility needs them
// before the PR panel mounts), so provision alone must not disable the
// connected loader — only read-only consumers that cannot call product APIs
// (and cannot merge) render straight from the supplied data.
export function shouldUsePreloadedPullRequests({ readOnly }: { readOnly: boolean }): boolean {
  return readOnly;
}
