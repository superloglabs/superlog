export type SuperlogEdition = "community" | "cloud" | "private";
export type BillingProvider = "none" | "stripe";

export type SystemCapabilities = {
  edition: SuperlogEdition;
  billing: BillingProvider;
  managedAgents: boolean;
  ossAgents: boolean;
  cloudUpgradeLinks: boolean;
};

type CapabilityEnv = Partial<
  Pick<
    NodeJS.ProcessEnv,
    "SUPERLOG_EDITION" | "SUPERLOG_BILLING_PROVIDER" | "SUPERLOG_MANAGED_AGENTS_ENABLED"
  >
>;

export function buildSystemCapabilities(env: CapabilityEnv = process.env): SystemCapabilities {
  const edition = parseEdition(env.SUPERLOG_EDITION);
  const billing = parseBillingProvider(env.SUPERLOG_BILLING_PROVIDER);
  const managedAgents = env.SUPERLOG_MANAGED_AGENTS_ENABLED === "true";

  return {
    edition,
    billing,
    managedAgents,
    ossAgents: true,
    cloudUpgradeLinks: edition === "community",
  };
}

function parseEdition(value: string | undefined): SuperlogEdition {
  if (value === "cloud" || value === "private" || value === "community") return value;
  return "community";
}

function parseBillingProvider(value: string | undefined): BillingProvider {
  if (value === "stripe") return "stripe";
  return "none";
}
