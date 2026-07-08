import type { AgentRunnerBackend } from "../../agent-runner-backend.js";
import { communityRunnerBackend } from "./community.js";

type AgentRunnerModule = {
  default?: unknown;
  agentRunnerBackend?: unknown;
};

let anthropicRunnerBackend: { specifier: string; backend: Promise<AgentRunnerBackend> } | null =
  null;

const disabledRunnerBackend: AgentRunnerBackend = {
  name: "disabled",
  maxRepoResources: 0,
  async start() {
    throw new Error("agent runner backend is disabled");
  },
  async startChat() {
    throw new Error("agent runner backend is disabled");
  },
  async sendChatMessage() {
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
  async dispatchChatToolCalls() {
    return { handled: 0, repliesThisTurn: 0 };
  },
};

export async function getAgentRunnerBackend(runtime: string): Promise<AgentRunnerBackend> {
  if (runtime === "community") return communityRunnerBackend;
  if (runtime === "disabled") return disabledRunnerBackend;
  if (runtime === "anthropic") {
    return loadConfiguredRunner("anthropic", "AGENT_RUNNER_ANTHROPIC_MODULE");
  }
  throw new Error(`unsupported agent runner backend: ${runtime}`);
}

async function loadConfiguredRunner(
  runtime: string,
  moduleEnvName: string,
): Promise<AgentRunnerBackend> {
  const specifier = process.env[moduleEnvName];
  if (!specifier) {
    throw new Error(`${moduleEnvName} is required to use the ${runtime} agent runner backend`);
  }
  if (!anthropicRunnerBackend || anthropicRunnerBackend.specifier !== specifier) {
    anthropicRunnerBackend = {
      specifier,
      backend: importRunnerModule(specifier, runtime),
    };
  }
  return anthropicRunnerBackend.backend;
}

async function importRunnerModule(specifier: string, runtime: string): Promise<AgentRunnerBackend> {
  const mod = (await import(specifier)) as AgentRunnerModule;
  const backend = mod.agentRunnerBackend ?? mod.default;
  if (!isAgentRunnerBackend(backend)) {
    throw new Error(
      `configured ${runtime} agent runner module must export an AgentRunnerBackend as agentRunnerBackend or default`,
    );
  }
  return backend;
}

function isAgentRunnerBackend(value: unknown): value is AgentRunnerBackend {
  if (!value || typeof value !== "object") return false;
  const backend = value as Partial<AgentRunnerBackend>;
  return (
    typeof backend.name === "string" &&
    typeof backend.maxRepoResources === "number" &&
    typeof backend.start === "function" &&
    typeof backend.startChat === "function" &&
    typeof backend.sendChatMessage === "function" &&
    typeof backend.collect === "function" &&
    typeof backend.resume === "function" &&
    typeof backend.steer === "function" &&
    typeof backend.dispatchIntegrationToolCalls === "function" &&
    typeof backend.dispatchChatToolCalls === "function"
  );
}
