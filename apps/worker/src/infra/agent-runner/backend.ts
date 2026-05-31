import type { AgentRunnerBackend } from "../../agent-runner-backend.js";

type ManagedAgentsModule = {
  MAX_AGENT_RUN_REPO_RESOURCES: number;
  startManagedAgentRun: AgentRunnerBackend["start"];
  collectManagedAgentRun: AgentRunnerBackend["collect"];
  resumeManagedAgentRun: AgentRunnerBackend["resume"];
  steerManagedAgentRun: AgentRunnerBackend["steer"];
  dispatchIntegrationToolCallsForSession: AgentRunnerBackend["dispatchIntegrationToolCalls"];
};

let anthropicRunnerBackend: Promise<AgentRunnerBackend> | null = null;

const disabledRunnerBackend: AgentRunnerBackend = {
  name: "disabled",
  maxRepoResources: 0,
  async start() {
    throw new Error("agent runner backend is disabled");
  },
  async collect() {
    throw new Error("agent runner backend is disabled");
  },
  async resume() {
    throw new Error("agent runner backend is disabled");
  },
  async steer() {
    throw new Error("agent runner backend is disabled");
  },
  async dispatchIntegrationToolCalls() {
    return 0;
  },
};

export async function getAgentRunnerBackend(runtime: string): Promise<AgentRunnerBackend> {
  if (runtime === "disabled") return disabledRunnerBackend;
  if (runtime === "anthropic") return loadAnthropicManagedRunner();
  throw new Error(`unsupported agent runner backend: ${runtime}`);
}

async function loadAnthropicManagedRunner(): Promise<AgentRunnerBackend> {
  anthropicRunnerBackend ??= importManagedAgentsModule().then((mod) => ({
    name: "anthropic",
    maxRepoResources: mod.MAX_AGENT_RUN_REPO_RESOURCES,
    start: mod.startManagedAgentRun,
    collect: mod.collectManagedAgentRun,
    resume: mod.resumeManagedAgentRun,
    steer: mod.steerManagedAgentRun,
    dispatchIntegrationToolCalls: mod.dispatchIntegrationToolCallsForSession,
  }));
  return anthropicRunnerBackend;
}

async function importManagedAgentsModule(): Promise<ManagedAgentsModule> {
  const specifier = "../../managed-agents.js";
  return import(specifier) as Promise<ManagedAgentsModule>;
}
