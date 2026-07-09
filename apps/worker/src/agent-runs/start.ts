import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { schema } from "@superlog/db";
import type {
  AgentRunContext,
  InstalledGithubRepo,
  ScoredGithubRepo,
} from "../agent-run-context.js";
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
  lifecycle: Pick<AgentRunLifecycle, "beginRepoDiscovery" | "startRunning">;
  getRunnerBackend(runtime: string): AgentRunnerBackend | Promise<AgentRunnerBackend>;
  listRepositories(ctx: AgentRunContext): Promise<InstalledGithubRepo[]>;
  scoreRepositories(repos: InstalledGithubRepo[], ctx: AgentRunContext): ScoredGithubRepo[];
  createRepositoryReadToken(installationId: number, repoId: number): Promise<string>;
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
  ): Promise<void>;
  blockForGithub(
    ctx: AgentRunContext,
    reason: "no_github_install" | "no_accessible_repos",
    summary: string,
  ): Promise<void>;
  pauseForRepositorySelection(
    ctx: AgentRunContext,
    question: string,
    summary: string,
  ): Promise<void>;
  notifyStarted(ctx: AgentRunContext, repoCandidateCount: number): Promise<void>;
};

export async function startQueuedAgentRunWorkflow(
  ctx: AgentRunContext,
  deps: StartQueuedAgentRunDeps,
): Promise<void> {
  const runner = await selectRunnerBackend(ctx, deps);
  if (!runner) return;

  const repos = await discoverAccessibleRepositories(ctx, deps);
  if (!repos) return;

  await deps.lifecycle.beginRepoDiscovery({
    id: ctx.agentRun.id,
    currentState: ctx.agentRun.state,
  });
  ctx.agentRun = { ...ctx.agentRun, state: "repo_discovery" };

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
    const repoCandidates = await createRunnerRepoCandidates(ctx, runner, scored, deps);
    if (repoCandidates.length === 0) {
      await deps.fail(
        ctx,
        "github_repo_token_failed",
        "Investigation failed to create GitHub access tokens for the selected repository candidates.",
      );
      return;
    }

    const session = await startRunnerSession(ctx, runner, repoCandidates, deps);
    await deps.lifecycle.startRunning({
      id: ctx.agentRun.id,
      currentState: "repo_discovery",
      providerSessionId: session.sessionId,
      providerSessionStatus: "running",
      repoCandidateCount: repoCandidates.length,
    });
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
): Promise<AgentRunnerRepoCandidate[]> {
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

  const candidates = await Promise.all(
    topScored.map(async (repo, index) =>
      createRunnerRepoCandidate(repo, index < INSTRUCTION_FILE_PROBE_LIMIT, deps),
    ),
  );
  return candidates.filter((repo): repo is AgentRunnerRepoCandidate => repo !== null);
}

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
  probeInstructionFiles: boolean,
  deps: StartQueuedAgentRunDeps,
): Promise<AgentRunnerRepoCandidate | null> {
  try {
    const installationToken = await deps.createRepositoryReadToken(
      repo.installation.installationId,
      repo.id,
    );
    return {
      fullName: repo.fullName,
      cloneUrl: `https://github.com/${repo.fullName}`,
      installationToken,
      score: repo.score,
      instructionFiles: probeInstructionFiles
        ? await probeRepoInstructionFiles(repo, installationToken, deps)
        : [],
    };
  } catch (err) {
    logger.warn(
      {
        err,
        installationId: repo.installation.installationId,
        repo: repo.fullName,
        repoId: repo.id,
      },
      "skipping inaccessible GitHub repo candidate",
    );
    return null;
  }
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
