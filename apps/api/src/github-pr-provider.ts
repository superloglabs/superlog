import type {
  AgentPullRequestProviderObservation as GithubPullRequestProviderObservation,
  AgentPullRequestProviderState as GithubPullRequestProviderState,
} from "@superlog/db";

type GithubPullRequestProviderResponse = {
  state: "open" | "closed";
  merged: boolean;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
  merged_by: { login?: string; id?: number } | null;
  title?: string | null;
  head?: { sha?: string | null } | null;
};

export type GithubPullRequestProviderSnapshot = Omit<
  GithubPullRequestProviderObservation,
  "targetState" | "providerUpdatedAt"
> & {
  targetState: GithubPullRequestProviderState;
  providerUpdatedAt: Date;
};

export async function loadGithubPullRequestProviderObservation(opts: {
  repoFullName: string;
  prNumber: number;
  observedAt: Date;
  request(pathname: string): Promise<GithubPullRequestProviderResponse>;
}): Promise<GithubPullRequestProviderSnapshot> {
  const current = await opts.request(`/repos/${opts.repoFullName}/pulls/${opts.prNumber}`);
  const targetState: GithubPullRequestProviderState = current.merged ? "merged" : current.state;

  return {
    targetState,
    observedAt: opts.observedAt,
    providerUpdatedAt: githubDate(current.updated_at),
    headSha: current.head?.sha ?? null,
    title: current.title ?? null,
    mergedAt: githubNullableDate(current.merged_at),
    closedAt: githubNullableDate(current.closed_at),
    mergedByLogin: current.merged_by?.login ?? null,
    mergedByGithubId: current.merged_by?.id ?? null,
  };
}

function githubNullableDate(value: string | null): Date | null {
  return value === null ? null : githubDate(value);
}

function githubDate(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`GitHub returned an invalid pull request timestamp: ${value}`);
  }
  return parsed;
}
