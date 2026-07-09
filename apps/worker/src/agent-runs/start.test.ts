import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { schema } from "@superlog/db";
import type { AgentRunContext, InstalledGithubRepo } from "../agent-run-context.js";
import type { AgentRunnerBackend, AgentRunnerStartInput } from "../agent-runner-backend.js";
import { type StartQueuedAgentRunDeps, startQueuedAgentRunWorkflow } from "./start.js";

test("startQueuedAgentRunWorkflow blocks before repo discovery when GitHub is not installed", async () => {
  const calls: string[] = [];
  const ctx = makeContext({ githubInstalled: false });

  await startQueuedAgentRunWorkflow(ctx, makeDeps(calls));

  assert.deepEqual(calls, [
    "getRunnerBackend",
    "blockForGithub:no_github_install:Investigation blocked: no GitHub App install for this project.",
  ]);
});

test("startQueuedAgentRunWorkflow asks for human repo selection when scoring produces no candidates", async () => {
  const calls: string[] = [];
  const ctx = makeContext();

  await startQueuedAgentRunWorkflow(
    ctx,
    makeDeps(calls, {
      scoreRepositories: () => [],
    }),
  );

  assert.deepEqual(calls, [
    "getRunnerBackend",
    "listRepositories",
    "beginRepoDiscovery",
    "pauseForRepositorySelection",
  ]);
  assert.equal(ctx.agentRun.state, "repo_discovery");
});

test("startQueuedAgentRunWorkflow starts runner with capped repo candidates", async () => {
  const calls: string[] = [];
  const ctx = makeContext();

  await startQueuedAgentRunWorkflow(ctx, makeDeps(calls));

  assert.deepEqual(calls, [
    "getRunnerBackend",
    "listRepositories",
    "beginRepoDiscovery",
    "createRepositoryReadToken:repo-1",
    "buildIssueSummaries",
    "runner.start:1",
    "prBaseBranch:development",
    "telemetryHint:session.id",
    "memories:0",
    "followUp:none",
    "startRunning:session-1:1",
    "notifyStarted:1",
  ]);
});

test("startQueuedAgentRunWorkflow passes agent memories to the runner", async () => {
  const calls: string[] = [];
  const ctx = makeContext();
  ctx.memories = [
    {
      id: "mem-1",
      kind: "terminology",
      title: "Sessions are called journeys",
      body: "This org refers to user sessions as journeys in dashboards and alerts.",
    } as schema.AgentMemory,
    {
      id: "mem-2",
      kind: "infra",
      title: "Checkout runs on ECS",
      body: "The checkout service deploys to ECS Fargate behind an ALB.",
    } as schema.AgentMemory,
  ];

  let received: Array<{ id: string; kind: string; title: string; body: string }> = [];
  await startQueuedAgentRunWorkflow(
    ctx,
    makeDeps(calls, undefined, (input) => {
      received = input.memories;
    }),
  );

  assert.deepEqual(received, [
    {
      id: "mem-1",
      kind: "terminology",
      title: "Sessions are called journeys",
      body: "This org refers to user sessions as journeys in dashboards and alerts.",
    },
    {
      id: "mem-2",
      kind: "infra",
      title: "Checkout runs on ECS",
      body: "The checkout service deploys to ECS Fargate behind an ALB.",
    },
  ]);
});

test("startQueuedAgentRunWorkflow passes probed instruction files to the runner", async () => {
  const calls: string[] = [];
  const ctx = makeContext();

  let received: string[][] = [];
  await startQueuedAgentRunWorkflow(
    ctx,
    makeDeps(
      calls,
      {
        async listRepositoryInstructionFiles(_token, repoFullName) {
          calls.push(`listRepositoryInstructionFiles:${repoFullName}`);
          return ["CLAUDE.md", ".cursor/rules/logging.mdc"];
        },
      },
      (input) => {
        received = input.repoCandidates.map((repo) => repo.instructionFiles);
      },
    ),
  );

  assert.ok(calls.includes("listRepositoryInstructionFiles:org/repo-1"));
  assert.deepEqual(received, [["CLAUDE.md", ".cursor/rules/logging.mdc"]]);
});

test("startQueuedAgentRunWorkflow starts with empty instruction files when probing fails", async () => {
  const calls: string[] = [];
  const ctx = makeContext();

  let received: string[][] = [];
  await startQueuedAgentRunWorkflow(
    ctx,
    makeDeps(
      calls,
      {
        async listRepositoryInstructionFiles() {
          throw new Error("github contents listing failed");
        },
      },
      (input) => {
        received = input.repoCandidates.map((repo) => repo.instructionFiles);
      },
    ),
  );

  assert.ok(calls.includes("runner.start:1"));
  assert.deepEqual(received, [[]]);
});

test("startQueuedAgentRunWorkflow fails cleanly when async backend selection rejects", async () => {
  const calls: string[] = [];
  const ctx = makeContext();
  ctx.agentRun.runtime = "missing-runtime";

  await startQueuedAgentRunWorkflow(
    ctx,
    makeDeps(calls, {
      async getRunnerBackend() {
        calls.push("getRunnerBackend");
        throw new Error("unsupported agent runner backend: missing-runtime");
      },
    }),
  );

  assert.deepEqual(calls, [
    "getRunnerBackend",
    "fail:unsupported_provider:Investigation provider missing-runtime is not supported.",
  ]);
});

function makeDeps(
  calls: string[],
  overrides: Partial<StartQueuedAgentRunDeps> = {},
  onStart?: (input: AgentRunnerStartInput) => void,
): StartQueuedAgentRunDeps {
  const runner: AgentRunnerBackend = {
    name: "test-runner",
    maxRepoResources: 1,
    async start(input) {
      calls.push(`runner.start:${input.repoCandidates.length}`);
      calls.push(`prBaseBranch:${input.prBaseBranch ?? "repo-default"}`);
      if (input.telemetryInvestigationHint.includes("session.id")) {
        calls.push("telemetryHint:session.id");
      }
      calls.push(`memories:${input.memories.length}`);
      calls.push(`followUp:${input.followUp ? input.followUp.trigger : "none"}`);
      onStart?.(input);
      return { sessionId: "session-1" };
    },
    async startChat() {
      throw new Error("not used");
    },
    async sendChatMessage() {
      throw new Error("not used");
    },
    async collect() {
      throw new Error("not used");
    },
    async resume() {
      throw new Error("not used");
    },
    async steer() {
      throw new Error("not used");
    },
    async dispatchIntegrationToolCalls() {
      throw new Error("not used");
    },
    async dispatchChatToolCalls() {
      throw new Error("not used");
    },
  };

  return {
    lifecycle: {
      async beginRepoDiscovery() {
        calls.push("beginRepoDiscovery");
      },
      async startRunning(opts: { providerSessionId: string; repoCandidateCount: number }) {
        calls.push(`startRunning:${opts.providerSessionId}:${opts.repoCandidateCount}`);
      },
    } as StartQueuedAgentRunDeps["lifecycle"],
    getRunnerBackend() {
      calls.push("getRunnerBackend");
      return runner;
    },
    async listRepositories() {
      calls.push("listRepositories");
      return [makeRepo("repo-1", 1), makeRepo("repo-2", 2)];
    },
    scoreRepositories(repos) {
      return repos.map((repo, index) => ({ ...repo, score: 100 - index }));
    },
    async createRepositoryReadToken(_installationId, repoId) {
      calls.push(`createRepositoryReadToken:repo-${repoId}`);
      return `token-${repoId}`;
    },
    async listRepositoryInstructionFiles() {
      return [];
    },
    async buildIssueSummaries() {
      calls.push("buildIssueSummaries");
      return [];
    },
    async fail(_ctx, reason, summary) {
      calls.push(`fail:${reason}:${summary}`);
    },
    async blockForGithub(_ctx, reason, summary) {
      calls.push(`blockForGithub:${reason}:${summary}`);
    },
    async pauseForRepositorySelection() {
      calls.push("pauseForRepositorySelection");
    },
    async notifyStarted(_ctx, repoCandidateCount) {
      calls.push(`notifyStarted:${repoCandidateCount}`);
    },
    ...overrides,
  };
}

function makeContext(opts: { githubInstalled?: boolean } = {}): AgentRunContext {
  return {
    agentRun: {
      id: "run-1",
      runtime: "test-runner",
      state: "queued",
    } as schema.AgentRun,
    incident: {
      id: "inc-1",
      title: "Incident",
      service: "api",
    } as schema.Incident,
    project: {
      id: "project-1",
      orgId: "org-1",
      name: "Project",
    } as schema.Project,
    automation: {
      autoInvestigateIssuesEnabled: true,
      agentRunProvider: "test-runner",
      maxRuntimeMinutes: 90,
      maxHumanResumeCount: 3,
    },
    githubInstalls:
      opts.githubInstalled === false
        ? []
        : [
            {
              installation: { id: "install-row-1" } as schema.GithubInstallation,
              allowedRepoIds: null,
            },
          ],
    linearInstall: null,
    customInstructions: "",
    linearTicketPolicy: "on_ready_to_pr",
    linearTicketInstructions: [],
    linearDefaultTeamId: null,
    prPolicy: "on_ready_to_pr",
    prBaseBranch: "development",
    autoMergeFixPrs: "never",
    autoMergeMethod: "squash",
    issueRows: [],
    memories: [],
    followUp: null,
    predecessors: [],
  };
}

function makeRepo(label: string, id: number): InstalledGithubRepo {
  return {
    id,
    fullName: `org/${label}`,
    private: true,
    installation: {
      installationId: 123,
    } as schema.GithubInstallation,
  };
}
