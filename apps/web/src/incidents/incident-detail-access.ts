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

export function incidentPullRequestDiffPath(diffBasePath: string, pullRequestId: string): string {
  return `${diffBasePath.replace(/\/$/, "")}/${encodeURIComponent(pullRequestId)}/diff`;
}

export type IncidentPullRequestDiffSource =
  | { kind: "recorded"; patch: string }
  | { kind: "remote"; path: string }
  | { kind: "unavailable" };

export function resolveIncidentPullRequestDiff(input: {
  patch: string | null;
  diffBasePath?: string;
  pullRequestId: string;
}): IncidentPullRequestDiffSource {
  if (input.patch) return { kind: "recorded", patch: input.patch };
  if (input.diffBasePath) {
    return {
      kind: "remote",
      path: incidentPullRequestDiffPath(input.diffBasePath, input.pullRequestId),
    };
  }
  return { kind: "unavailable" };
}
