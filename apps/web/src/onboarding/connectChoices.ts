// Catalog + routing for the "Connect your data" onboarding fork, split out from
// the component so the ordering rules are unit-testable (the `.tsx` can't be
// imported by the node:test runner).
//
// Design principle (see design.md): integration-first. A connected, no-code
// integration beats hand-written instrumentation for time-to-value, so the
// no-code integrations (AWS, Cloudflare, Vercel) come first and the "I'm hosted
// elsewhere" fallback — which routes to the coding-agent prompt — comes last.

// What activating a row does. `null` => not yet available (coming soon), so the
// row renders disabled and is not actionable. "code" opens the coding-agent
// prompt (paste into Cursor / Claude Code / Codex).
export type ConnectAction = "aws" | "cloudflare" | "vercel" | "railway" | "render" | "code";

// Glyph key resolved to a neutral monochrome icon by the component. Kept as a
// string union (not a component) so this module stays free of JSX/React.
export type ConnectIcon = "aws" | "cloudflare" | "vercel" | "railway" | "render" | "terminal";

export type ConnectOption = {
  id: string;
  title: string;
  description: string;
  icon: ConnectIcon;
  action: ConnectAction | null;
  badge?: string;
};

export type ConnectSection = {
  id: string;
  label: string;
  // "list" => grouped rows with chevrons; "grid" => lighter 2-up tiles.
  variant: "list" | "grid";
  options: ConnectOption[];
};

export const CONNECT_SECTIONS: ConnectSection[] = [
  {
    id: "sources",
    // No section label — the three lanes read as peers under the page subtitle.
    label: "",
    variant: "list",
    options: [
      {
        id: "aws",
        title: "Amazon Web Services",
        description:
          "Stream CloudWatch logs and metrics and auto-discover resources from one CloudFormation stack. No agent, no code.",
        icon: "aws",
        action: "aws",
      },
      {
        id: "cloudflare",
        title: "Cloudflare",
        description:
          "Authorize Cloudflare once and we set up Workers Observability destinations that stream your Workers traces, logs, and metrics in. No agent, no code.",
        icon: "cloudflare",
        action: "cloudflare",
      },
      {
        id: "vercel",
        title: "Vercel",
        description:
          "Install the Superlog integration once and we set up trace and log drains that stream your deployments' telemetry in. No agent, no code.",
        icon: "vercel",
        action: "vercel",
      },
      {
        id: "railway",
        title: "Railway",
        description:
          "Authorize Railway once and pick the projects to share — we pull your services' logs and infra metrics from Railway's API. No agent, no code.",
        icon: "railway",
        action: "railway",
      },
      {
        id: "render",
        title: "Render",
        description:
          "Paste a Render API key once and pick the workspace to share — Render streams your services' logs and infra metrics straight in. No agent, no code.",
        icon: "render",
        action: "render",
      },
      {
        id: "elsewhere",
        title: "I'm hosted elsewhere",
        description:
          "Fly, a VM, your laptop — anywhere. Paste a prompt into Cursor, Claude Code, or Codex and it installs the SDK, instruments your app, and opens a PR.",
        icon: "terminal",
        action: "code",
      },
    ],
  },
];

// Runtime availability for connectors that depend on server-side config. The
// backend self-disables the Cloudflare / Vercel connectors when their OAuth
// client / OTLP intake env isn't set (see system-capabilities), so the chooser
// must not offer a click that would 503 — it renders the tile as "coming soon"
// until the API reports the connector is configured.
export type ConnectAvailability = {
  cloudflare: boolean;
  vercel: boolean;
  railway: boolean;
  render: boolean;
};

export function connectSectionsFor(availability: ConnectAvailability): ConnectSection[] {
  const unavailable = new Set<string>();
  if (!availability.cloudflare) unavailable.add("cloudflare");
  if (!availability.vercel) unavailable.add("vercel");
  if (!availability.railway) unavailable.add("railway");
  if (!availability.render) unavailable.add("render");
  if (unavailable.size === 0) return CONNECT_SECTIONS;
  return CONNECT_SECTIONS.map((section) => ({
    ...section,
    options: section.options.map((option) =>
      unavailable.has(option.id)
        ? { ...option, action: null, description: "Coming soon", badge: undefined }
        : option,
    ),
  }));
}

export function isComingSoon(option: ConnectOption): boolean {
  return option.action === null;
}

// Flattened lookup of an option's action by id (used by the click handler).
export function connectActionFor(id: string): ConnectAction | null {
  for (const section of CONNECT_SECTIONS) {
    const found = section.options.find((o) => o.id === id);
    if (found) return found.action;
  }
  return null;
}

// First actionable option across all sections, in display order — this is the
// row we expect to be the primary, integration-first recommendation.
export function primaryConnectOption(): ConnectOption {
  for (const section of CONNECT_SECTIONS) {
    const actionable = section.options.find((o) => o.action !== null);
    if (actionable) return actionable;
  }
  throw new Error("no actionable connect option configured");
}
