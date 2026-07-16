export type ObservabilityReviewCommand = {
  installationId: number;
  repoId: number;
  repoFullName: string;
  prNumber: number;
  headSha: string;
};

export type ObservabilityReviewScope = { orgId: string; projectId: string };

export type ObservabilityReviewEnqueue = ObservabilityReviewCommand & {
  scopes: ObservabilityReviewScope[];
};

type PullRequestWebhookPayload = {
  action?: string;
  installation?: { id?: number };
  repository?: { id?: number; full_name?: string };
  pull_request?: {
    number?: number;
    draft?: boolean;
    head?: { sha?: string };
  };
};

const REVIEW_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);

export function observabilityReviewCommandFromWebhook(
  event: string,
  payload: PullRequestWebhookPayload,
): ObservabilityReviewCommand | null {
  if (event !== "pull_request" || !REVIEW_ACTIONS.has(payload.action ?? "")) return null;
  if (payload.pull_request?.draft === true) return null;

  const installationId = payload.installation?.id;
  const repoId = payload.repository?.id;
  const repoFullName = payload.repository?.full_name;
  const prNumber = payload.pull_request?.number;
  const headSha = payload.pull_request?.head?.sha;
  if (
    !Number.isFinite(installationId) ||
    !Number.isFinite(repoId) ||
    !repoFullName ||
    !Number.isFinite(prNumber) ||
    !headSha
  ) {
    return null;
  }
  return {
    installationId: installationId as number,
    repoId: repoId as number,
    repoFullName,
    prNumber: prNumber as number,
    headSha,
  };
}

export async function enqueueObservabilityReview(
  command: ObservabilityReviewCommand,
  deps: {
    findEnabledScopes(command: ObservabilityReviewCommand): Promise<ObservabilityReviewScope[]>;
    insert(input: ObservabilityReviewEnqueue): Promise<void>;
  },
): Promise<boolean> {
  const scopes = await deps.findEnabledScopes(command);
  if (scopes.length === 0) return false;
  await deps.insert({ ...command, scopes });
  return true;
}
