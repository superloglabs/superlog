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
  // Same gate for the Vercel connector (OAuth client + integration slug +
  // OTLP intake).
  vercelConnect: boolean;
  // Same gate for the Railway connector (OAuth client only — telemetry is
  // pulled by the worker, so there's no intake URL to configure here).
  railwayConnect: boolean;
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
    | "VERCEL_CLIENT_ID"
    | "VERCEL_CLIENT_SECRET"
    | "VERCEL_INTEGRATION_SLUG"
    | "VERCEL_OTLP_INTAKE_URL"
    | "RAILWAY_CLIENT_ID"
    | "RAILWAY_CLIENT_SECRET"
    | "STATE_SIGNING_SECRET"
  >
>;

export function buildSystemCapabilities(env: CapabilityEnv = process.env): SystemCapabilities {
  const edition = parseEdition(env.SUPERLOG_EDITION);
  const billing = parseBillingProvider(env.SUPERLOG_BILLING_PROVIDER);
  const managedAgents = env.SUPERLOG_MANAGED_AGENTS_ENABLED === "true";
  // Mirror cloudflareConfigFromEnv's required-vars check (kept inline so this
  // module stays dependency-free) AND the install-url route's STATE_SIGNING_SECRET
  // requirement — without the latter the connector would advertise as available
  // but `install-url` would 503. The connector self-disables without all of these.
  const cloudflareConnect = !!(
    env.CLOUDFLARE_CLIENT_ID &&
    env.CLOUDFLARE_CLIENT_SECRET &&
    env.CLOUDFLARE_OTLP_INTAKE_URL &&
    env.STATE_SIGNING_SECRET
  );
  // Mirrors vercelConfigFromEnv's required-vars check plus the install-url
  // route's STATE_SIGNING_SECRET requirement, same as the Cloudflare gate.
  const vercelConnect = !!(
    env.VERCEL_CLIENT_ID &&
    env.VERCEL_CLIENT_SECRET &&
    env.VERCEL_INTEGRATION_SLUG &&
    env.VERCEL_OTLP_INTAKE_URL &&
    env.STATE_SIGNING_SECRET
  );
  // Mirrors railwayConfigFromEnv's required-vars check plus STATE_SIGNING_SECRET.
  const railwayConnect = !!(
    env.RAILWAY_CLIENT_ID &&
    env.RAILWAY_CLIENT_SECRET &&
    env.STATE_SIGNING_SECRET
  );

  return {
    edition,
    billing,
    managedAgents,
    ossAgents: true,
    cloudUpgradeLinks: edition === "community",
    cloudflareConnect,
    vercelConnect,
    railwayConnect,
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
