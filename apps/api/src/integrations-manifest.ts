export type IntegrationManifestSecret = {
  name: string;
  description: string;
};

export type IntegrationManifest = {
  slug: string;
  name: string;
  description: string;
  required_secrets: IntegrationManifestSecret[];
};

export const INTEGRATION_MANIFESTS: Record<string, IntegrationManifest> = {
  revyl: {
    slug: "revyl",
    name: "Revyl",
    description:
      "Trigger and inspect Revyl test runs and workflows; author new regression tests from YAML.",
    required_secrets: [
      {
        name: "REVYL_API_KEY",
        description: "Revyl bearer token (Settings → API Keys in Revyl).",
      },
    ],
  },
};
