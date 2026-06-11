export const DEFAULT_AGENT_RUN_PROVIDER = "community";

export const AGENT_RUN_PROVIDERS = ["community", "anthropic", "disabled"] as const;

export type AgentRunProvider = (typeof AGENT_RUN_PROVIDERS)[number];

export function isAgentRunProvider(value: unknown): value is AgentRunProvider {
  return typeof value === "string" && AGENT_RUN_PROVIDERS.includes(value as AgentRunProvider);
}

/**
 * Deployment-level default for new projects (and projects without an
 * automation row). Set the DEFAULT_AGENT_RUN_PROVIDER env var to override the
 * built-in community default — e.g. a hosted deployment that runs every
 * project on a managed runner. Invalid values throw so a typo in deploy config
 * fails loudly instead of silently reverting to community.
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
