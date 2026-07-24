import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { schema } from "@superlog/db";
import type {
  AgentRunContext,
  InstalledGithubRepo,
  ScoredGithubRepo,
} from "../agent-run-context.js";
import { RetryableGithubRepoDiscoveryError } from "../agent-run-context.js";
import type { AgentRunLifecycle } from "../agent-run.js";
import type {
  AgentRunnerBackend,
  AgentRunnerIssueSummary,
  AgentRunnerRepoCandidate,
} from "../agent-runner-backend.js";
import { logger } from "../logger.js";

const tracer = trace.getTracer("@superlog/worker");
export const TELEMETRY_INVESTIGATION_HINT =
  "When an issue sample includes a session.id attribute, use it to query preceding traces and logs from the same user/app session before focusing only on the failing trace or log line.";

export type StartQueuedAgentRunDeps = {
  lifecycle: Pick<
    AgentRunLifecycle,
    | "beginRepoDiscovery"
    | "startRunning"
    | "recordDetachedSessionTerminationPending"
    | "markDetachedSessionTerminated"
  >;
  getRunnerBackend(runtime: string): AgentRunnerBackend | Promise<AgentRunnerBackend>;
  listRepositories(ctx: AgentRunContext): Promise<InstalledGithubRepo[]>;
  scoreRepositories(repos: InstalledGithubRepo[], ctx: AgentRunContext): ScoredGithubRepo[];
  createRepositoryReadTokenForRepositories(
    installationId: number,
    repositoryIds: number[],
  ): Promise<string>;
  isRetryableRepositoryError(error: unknown): boolean;
  listRepositoryInstructionFiles(
    installationToken: string,
    repoFullName: string,
  ): Promise<string[]>;
  buildIssueSummaries(ctx: AgentRunContext): Promise<AgentRunnerIssueSummary[]>;
  fail(
    ctx: AgentRunContext,
    reason: schema.AgentRunFailureReason,
    summary: string,
    detail?: { err?: unknown },
  ): Promise<boolean>;
  blockForGithub(
    ctx: AgentRunContext,
    reason: "no_github_install" | "no_accessible_repos",
    summary: string,
  ): Promise<boolean>;
  pauseForRepositorySelection(
    ctx: AgentRunContext,
    question: string,
    summary: string,
  ): Promise<boolean>;
  notifyStarted(ctx: AgentRunContext, repoCandidateCount: number): Promise<void>;
};

export async function startQueuedAgentRunWorkflow(
  ctx: AgentRunContext,
  deps: StartQueuedAgentRunDeps,
): Promise<void> {
  const beganRepoDiscovery = await deps.lifecycle.beginRepoDiscovery({
    id: ctx.agentRun.id,
    incidentId: ctx.incident.id,
    currentState: ctx.agentRun.state,
  });
  if (!beganRepoDiscovery) return;
  ctx.agentRun = { ...ctx.agentRun, state: "repo_discovery" };

  const runner = await selectRunnerBackend(ctx, deps);
  if (!runner) return;

  const repos = await discoverAccessibleRepositories(ctx, deps);
  if (!repos) return;

  const scored = deps.scoreRepositories(repos, ctx);
  if (scored.length === 0) {
    await deps.pauseForRepositorySelection(
      ctx,
      "Reply with the repository name that likely owns this incident.",
      "Investigation paused because repo discovery produced no candidates.",
    );
    return;
  }

  try {
    const { candidates: repoCandidates, errors: repoCandidateErrors } =
      await createRunnerRepoCandidates(ctx, runner, scored, deps);
    if (repoCandidates.length === 0) {
      if (repoCandidateErrors.some(deps.isRetryableRepositoryError)) {
        logger.error(
          {
            agent_run_id: ctx.agentRun.id,
            incident_id: ctx.incident.id,
            failed_installation_count: repoCandidateErrors.length,
          },
          "repository authorization temporarily unavailable; will retry on the next sweep",
        );
        return;
      }
      await deps.fail(
        ctx,
        "github_repo_token_failed",
        "Investigation failed to create GitHub access tokens for the selected repository candidates.",
      );
      return;
    }

    const session = await startRunnerSession(ctx, runner, repoCandidates, deps);
    const started = await deps.lifecycle.startRunning({
      id: ctx.agentRun.id,
      incidentId: ctx.incident.id,
      currentState: "repo_discovery",
      providerSessionId: session.sessionId,
      providerSessionStatus: "running",
      repoCandidateCount: repoCandidates.length,
    });
    if (!started) {
      try {
        await deps.lifecycle.recordDetachedSessionTerminationPending({
          id: ctx.agentRun.id,
          incidentId: ctx.incident.id,
          runtime: ctx.agentRun.runtime,
          providerSessionId: session.sessionId,
        });
      } catch (recordErr) {
        try {
          await runner.terminate(session.sessionId);
          logger.error(
            {
              recordErr,
              agent_run_id: ctx.agentRun.id,
              incident_id: ctx.incident.id,
              provider_session_id: session.sessionId,
            },
            "terminated an unowned provider session after cleanup persistence failed",
          );
          return;
        } catch (terminateErr) {
          logger.error(
            {
              recordErr,
              terminateErr,
              agent_run_id: ctx.agentRun.id,
              incident_id: ctx.incident.id,
              provider_session_id: session.sessionId,
            },
            "provider session cleanup and its durable fallback both failed",
          );
          throw new AggregateError(
            [recordErr, terminateErr],
            "failed to retain or terminate an unowned provider session",
          );
        }
      }
      await runner.terminate(session.sessionId);
      await deps.lifecycle.markDetachedSessionTerminated({
        id: ctx.agentRun.id,
        providerSessionId: session.sessionId,
      });
      return;
    }
    logStarted(ctx, runner, session.sessionId, repoCandidates.length);
    await deps.notifyStarted(ctx, repoCandidates.length);
  } catch (err) {
    await deps.fail(ctx, "start_failed", "Investigation failed to start.", { err });
  }
}

async function selectRunnerBackend(
  ctx: AgentRunContext,
  deps: StartQueuedAgentRunDeps,
): Promise<AgentRunnerBackend | null> {
  try {
    return await deps.getRunnerBackend(ctx.agentRun.runtime);
  } catch {
    await deps.fail(
      ctx,
      "unsupported_provider",
      `Investigation provider ${ctx.agentRun.runtime} is not supported.`,
    );
    return null;
  }
}

async function discoverAccessibleRepositories(
  ctx: AgentRunContext,
  deps: StartQueuedAgentRunDeps,
): Promise<InstalledGithubRepo[] | null> {
  if (ctx.githubInstalls.length === 0) {
    await deps.blockForGithub(
      ctx,
      "no_github_install",
      "Investigation blocked: no GitHub App install for this project.",
    );
    return null;
  }

  let repos: InstalledGithubRepo[];
  try {
    repos = await deps.listRepositories(ctx);
  } catch (err) {
    if (err instanceof RetryableGithubRepoDiscoveryError) {
      logger.warn(
        {
          err,
          agent_run_id: ctx.agentRun.id,
          incident_id: ctx.incident.id,
        },
        "repository discovery temporarily unavailable; will retry on the next sweep",
      );
      return null;
    }
    await deps.fail(
      ctx,
      "github_repo_discovery_failed",
      "Investigation failed to list GitHub repositories.",
      {
        err,
      },
    );
    return null;
  }

  if (repos.length === 0) {
    await deps.blockForGithub(
      ctx,
      "no_accessible_repos",
      "Investigation blocked: GitHub install has no accessible repositories.",
    );
    return null;
  }

  return repos;
}

async function createRunnerRepoCandidates(
  ctx: AgentRunContext,
  runner: AgentRunnerBackend,
  scored: ScoredGithubRepo[],
  deps: StartQueuedAgentRunDeps,
): Promise<{ candidates: AgentRunnerRepoCandidate[]; errors: unknown[] }> {
  const topScored = scored.slice(0, runner.maxRepoResources);
  if (scored.length > topScored.length) {
    logger.info(
      {
        scope: "agent_run",
        agent_run_id: ctx.agentRun.id,
        incident_id: ctx.incident.id,
        total_candidates: scored.length,
        kept: topScored.length,
      },
      "capping repo candidates to fit agent runner resources limit",
    );
  }

  const reposByInstallation = new Map<number, ScoredGithubRepo[]>();
  for (const repo of topScored) {
    const installationId = repo.installation.installationId;
    const repos = reposByInstallation.get(installationId) ?? [];
    repos.push(repo);
    reposByInstallation.set(installationId, repos);
  }
  // One token can cover up to 500 selected repositories from an installation.
  // Sharing each token across a bounded chunk preserves the run's aggregate
  // access while avoiding one token POST per repository (a 100-request burst
  // previously triggered GitHub's secondary rate limit).
  type TokenResult = { token: string; error: null } | { token: null; error: unknown };
  const tokenResults: Promise<TokenResult>[] = [];
  const tokenResultByRepo = new Map<ScoredGithubRepo, Promise<TokenResult>>();
  for (const [installationId, repos] of reposByInstallation) {
    let previousChunk = Promise.resolve();
    for (let offset = 0; offset < repos.length; offset += GITHUB_TOKEN_MAX_REPOSITORIES) {
      const chunk = repos.slice(offset, offset + GITHUB_TOKEN_MAX_REPOSITORIES);
      const tokenResult = previousChunk
        .then(() =>
          deps.createRepositoryReadTokenForRepositories(
            installationId,
            chunk.map((repo) => repo.id),
          ),
        )
        .then<TokenResult, TokenResult>(
          (token) => ({ token, error: null }),
          (error: unknown) => {
            logger.error(
              {
                err: error,
                installationId,
                repo_count: chunk.length,
              },
              "failed to authorize GitHub repository candidates",
            );
            return { token: null, error };
          },
        );
      previousChunk = tokenResult.then(() => undefined);
      tokenResults.push(tokenResult);
      for (const repo of chunk) tokenResultByRepo.set(repo, tokenResult);
    }
  }

  const candidates = await Promise.all(
    topScored.map(async (repo, index) => {
      const tokenResult = await tokenResultByRepo.get(repo);
      if (!tokenResult?.token) return null;
      return createRunnerRepoCandidate(
        repo,
        tokenResult.token,
        index < INSTRUCTION_FILE_PROBE_LIMIT,
        deps,
      );
    }),
  );
  const resolvedTokenResults = await Promise.all(tokenResults);
  return {
    candidates: candidates.filter((repo): repo is AgentRunnerRepoCandidate => repo !== null),
    errors: resolvedTokenResults.flatMap((result) => (result.error === null ? [] : [result.error])),
  };
}

const GITHUB_TOKEN_MAX_REPOSITORIES = 500;

// Each probe costs up to three GitHub contents-API requests, so only the
// strongest candidates get one; the rest start with an empty list and the
// agent falls back to looking for instruction files itself after cloning.
const INSTRUCTION_FILE_PROBE_LIMIT = 10;

// Best-effort: the probe must never cost us a repo candidate, so both
// rejected promises and synchronous throws from the dep degrade to [].
async function probeRepoInstructionFiles(
  repo: ScoredGithubRepo,
  installationToken: string,
  deps: StartQueuedAgentRunDeps,
): Promise<string[]> {
  try {
    return await deps.listRepositoryInstructionFiles(installationToken, repo.fullName);
  } catch (err) {
    logger.warn(
      { err, repo: repo.fullName },
      "instruction-file probe failed; starting without repo instruction files",
    );
    return [];
  }
}

async function createRunnerRepoCandidate(
  repo: ScoredGithubRepo,
  installationToken: string,
  probeInstructionFiles: boolean,
  deps: StartQueuedAgentRunDeps,
): Promise<AgentRunnerRepoCandidate> {
  return {
    fullName: repo.fullName,
    cloneUrl: `https://github.com/${repo.fullName}`,
    installationToken,
    score: repo.score,
    instructionFiles: probeInstructionFiles
      ? await probeRepoInstructionFiles(repo, installationToken, deps)
      : [],
  };
}

async function startRunnerSession(
  ctx: AgentRunContext,
  runner: AgentRunnerBackend,
  repoCandidates: AgentRunnerRepoCandidate[],
  deps: StartQueuedAgentRunDeps,
): Promise<{ sessionId: string }> {
  return tracer.startActiveSpan("llm.investigate", async (llmSpan) => {
    llmSpan.setAttribute("agent_run.id", ctx.agentRun.id);
    llmSpan.setAttribute("agent_run.incident_id", ctx.incident.id);
    llmSpan.setAttribute("agent_run.repo_count", repoCandidates.length);
    llmSpan.setAttribute("agent_run.provider", runner.name);
    try {
      const result = await runner.start({
        incidentId: ctx.incident.id,
        projectId: ctx.project.id,
        orgId: ctx.project.orgId,
        title: ctx.incident.title,
        service: ctx.incident.service,
        issueSummaries: await deps.buildIssueSummaries(ctx),
        repoCandidates,
        mcpResource: `${(process.env.API_BASE_URL ?? "https://api.superlog.sh").replace(/\/$/, "")}/mcp`,
        prPolicy: ctx.prPolicy,
        approvalPromptsEnabled: ctx.approvalPromptsEnabled,
        // ask_human is the approval boundary exposed by every runner. The
        // project setting decides whether it counts as an available
        // intervention when terminal tools are registered.
        approvalPromptToolsAvailable: true,
        prBaseBranch: ctx.prBaseBranch,
        githubConnected: ctx.githubInstalls.length > 0,
        telemetryInvestigationHint: TELEMETRY_INVESTIGATION_HINT,
        customInstructions: ctx.customInstructions,
        customPrompt: ctx.agentRun.prompt ?? null,
        memories: ctx.memories.map((memory) => ({
          id: memory.id,
          kind: memory.kind,
          title: memory.title,
          body: memory.body,
        })),
        followUp: ctx.followUp,
        predecessors: ctx.predecessors,
      });
      llmSpan.setAttribute("agent_run.session_id", result.sessionId);
      return result;
    } catch (err) {
      llmSpan.recordException(err as Error);
      llmSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      llmSpan.end();
    }
  });
}

function logStarted(
  ctx: AgentRunContext,
  runner: AgentRunnerBackend,
  sessionId: string,
  repoCandidateCount: number,
): void {
  logger.info(
    {
      scope: "agent_run",
      agent_run_id: ctx.agentRun.id,
      incident_id: ctx.incident.id,
      project_id: ctx.project.id,
      org_id: ctx.project.orgId,
      session_id: sessionId,
      provider: runner.name,
      repo_candidate_count: repoCandidateCount,
    },
    "agent run started",
  );
}
