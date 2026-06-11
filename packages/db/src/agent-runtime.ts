export const DEFAULT_AGENT_RUN_PROVIDER = "community";

export const AGENT_RUN_PROVIDERS = ["community", "anthropic", "disabled"] as const;

export type AgentRunProvider = (typeof AGENT_RUN_PROVIDERS)[number];

export function isAgentRunProvider(value: unknown): value is AgentRunProvider {
  return typeof value === "string" && AGENT_RUN_PROVIDERS.includes(value as AgentRunProvider);
}

/**
 * Default provider for new projects (and projects without an automation row).
 * Deployments can override the built-in default with the
 * DEFAULT_AGENT_RUN_PROVIDER env var — e.g. set it to "disabled" to keep agent
 * runs off until a project opts in. Invalid values throw so a deploy-config
 * typo fails loudly instead of silently falling back.
 */
export function resolveDefaultAgentRunProvider(
  env: Record<string, string | undefined> = process.env,
): AgentRunProvider {
  const value = env.DEFAULT_AGENT_RUN_PROVIDER;
  if (value === undefined || value === "") return DEFAULT_AGENT_RUN_PROVIDER;
  if (!isAgentRunProvider(value)) {
    throw new Error(
      `DEFAULT_AGENT_RUN_PROVIDER must be one of: ${AGENT_RUN_PROVIDERS.join(", ")} (got "${value}")`,
    );
  }
  return value;
}
