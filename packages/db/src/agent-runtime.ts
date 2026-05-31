export const DEFAULT_AGENT_RUN_PROVIDER = "community";

export const AGENT_RUN_PROVIDERS = ["community", "anthropic", "disabled"] as const;

export type AgentRunProvider = (typeof AGENT_RUN_PROVIDERS)[number];

export function isAgentRunProvider(value: unknown): value is AgentRunProvider {
  return typeof value === "string" && AGENT_RUN_PROVIDERS.includes(value as AgentRunProvider);
}
