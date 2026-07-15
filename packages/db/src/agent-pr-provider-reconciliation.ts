export type AgentPullRequestProviderState = "open" | "closed" | "merged";

export type AgentPullRequestProviderObservation = {
  targetState?: AgentPullRequestProviderState;
  observedAt: Date;
  providerUpdatedAt?: Date;
  providerSnapshotAuthoritative?: boolean;
  headSha?: string | null;
  title?: string | null;
  mergedAt?: Date | null;
  closedAt?: Date | null;
  mergedByLogin?: string | null;
  mergedByGithubId?: number | null;
};

export type AgentPullRequestProviderMutation = {
  pullRequestState: AgentPullRequestProviderState | null;
  stateChanged: boolean;
  providerReconciliationRequired: boolean;
};

export type AgentPullRequestProviderReconciliation<
  Mutation extends AgentPullRequestProviderMutation = AgentPullRequestProviderMutation,
> = {
  mutation: Mutation;
  appliedObservation: AgentPullRequestProviderObservation;
};

function needsAuthoritativeObservationBeforeApply(
  observation: AgentPullRequestProviderObservation,
): boolean {
  return (
    observation.providerSnapshotAuthoritative !== true &&
    observation.providerUpdatedAt === undefined &&
    (observation.targetState === "open" || observation.targetState === "closed")
  );
}

// Reversible provider states need an ordering watermark. A missing watermark
// cannot be compared with a canonical observation, while an equal watermark
// cannot order opposite events from a second-precision provider clock. In
// either case, apply one authoritative snapshot instead of guessing from
// local arrival order.
export async function reconcileAgentPullRequestProviderObservation<
  Mutation extends AgentPullRequestProviderMutation,
>(
  observation: AgentPullRequestProviderObservation,
  deps: {
    applyObservation(observation: AgentPullRequestProviderObservation): Promise<Mutation>;
    loadAuthoritativeObservation(): Promise<AgentPullRequestProviderObservation>;
  },
): Promise<AgentPullRequestProviderReconciliation<Mutation>> {
  if (needsAuthoritativeObservationBeforeApply(observation)) {
    return applyAuthoritativeObservation(deps);
  }

  const mutation = await deps.applyObservation(observation);
  if (!mutation.providerReconciliationRequired) {
    return { mutation, appliedObservation: observation };
  }
  return applyAuthoritativeObservation(deps);
}

async function applyAuthoritativeObservation<
  Mutation extends AgentPullRequestProviderMutation,
>(deps: {
  applyObservation(observation: AgentPullRequestProviderObservation): Promise<Mutation>;
  loadAuthoritativeObservation(): Promise<AgentPullRequestProviderObservation>;
}): Promise<AgentPullRequestProviderReconciliation<Mutation>> {
  const authoritative = {
    ...(await deps.loadAuthoritativeObservation()),
    providerSnapshotAuthoritative: true,
  };
  const reconciled = await deps.applyObservation(authoritative);
  if (reconciled.providerReconciliationRequired) {
    throw new Error("authoritative provider PR state remained ambiguous");
  }
  return { mutation: reconciled, appliedObservation: authoritative };
}
