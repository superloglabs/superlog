export type SuperlogEdition = "community" | "cloud" | "private";
export type BillingProvider = "none" | "stripe";

export type SystemCapabilities = {
  edition: SuperlogEdition;
  billing: BillingProvider;
  managedAgents: boolean;
  ossAgents: boolean;
  cloudUpgradeLinks: boolean;
  // Whether the Cloudflare "Connect" connector is configured in this
  // environment (OAuth client + OTLP intake). The web uses this to gate the
  // Cloudflare onboarding option instead of offering a click that would 503.
  cloudflareConnect: boolean;
};

type CapabilityEnv = Partial<
  Pick<
    NodeJS.ProcessEnv,
    | "SUPERLOG_EDITION"
    | "SUPERLOG_BILLING_PROVIDER"
    | "SUPERLOG_MANAGED_AGENTS_ENABLED"
    | "CLOUDFLARE_CLIENT_ID"
    | "CLOUDFLARE_CLIENT_SECRET"
    | "CLOUDFLARE_OTLP_INTAKE_URL"
  >
>;

export function buildSystemCapabilities(env: CapabilityEnv = process.env): SystemCapabilities {
  const edition = parseEdition(env.SUPERLOG_EDITION);
  const billing = parseBillingProvider(env.SUPERLOG_BILLING_PROVIDER);
  const managedAgents = env.SUPERLOG_MANAGED_AGENTS_ENABLED === "true";
  // Mirror cloudflareConfigFromEnv's required-vars check (kept inline so this
  // module stays dependency-free); the connector self-disables without these.
  const cloudflareConnect = !!(
    env.CLOUDFLARE_CLIENT_ID &&
    env.CLOUDFLARE_CLIENT_SECRET &&
    env.CLOUDFLARE_OTLP_INTAKE_URL
  );

  return {
    edition,
    billing,
    managedAgents,
    ossAgents: true,
    cloudUpgradeLinks: edition === "community",
    cloudflareConnect,
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
