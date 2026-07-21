import type { AgentRunnerBackend, AgentRunnerSnapshot } from "../agent-runner-backend.js";

export type RecoverableRepository = {
  fullName: string;
  id: number;
  installationId: number;
};

export async function recoverExhaustedRunnerTurn(input: {
  sessionId: string;
  failure: NonNullable<AgentRunnerSnapshot["recoverableFailure"]>;
  runner: Pick<AgentRunnerBackend, "recover">;
  listRepositories(): Promise<RecoverableRepository[]>;
  createRepositoryReadToken(installationId: number, repositoryId: number): Promise<string>;
  claimRecovery(providerEventId: string): Promise<{ id: string } | null>;
  releaseRecoveryClaim(id: string): Promise<void>;
}): Promise<"recovered" | "already_claimed" | "unsupported"> {
  if (!input.runner.recover) return "unsupported";

  const claim = await input.claimRecovery(input.failure.providerEventId);
  if (!claim) return "already_claimed";

  try {
    const repositories = new Map(
      (await input.listRepositories()).map((repository) => [repository.fullName, repository]),
    );
    await input.runner.recover(input.sessionId, {
      continuationMessage: recoveryContinuationMessage(input.failure.providerEventId),
      authorizeRepository: async (fullName) => {
        const repository = repositories.get(fullName);
        if (!repository) {
          throw new Error(`managed session repository is no longer accessible: ${fullName}`);
        }
        return input.createRepositoryReadToken(repository.installationId, repository.id);
      },
    });
    return "recovered";
  } catch (err) {
    await input.releaseRecoveryClaim(claim.id).catch(() => undefined);
    throw err;
  }
}

export function recoveryContinuationMessage(providerEventId: string): string {
  return [
    `[SUPERLOG_SESSION_RECOVERY ${providerEventId}]`,
    "The previous turn ended because the managed service exhausted its retries. Repository credentials have been refreshed. Continue the existing investigation from its current context. First verify that the mounted repositories are available, then finish the investigation and use the appropriate terminal outcome tool.",
  ].join("\n");
}
