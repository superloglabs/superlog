// Catalog + routing for the "Connect your data" onboarding fork, split out from
// the component so the ordering rules are unit-testable (the `.tsx` can't be
// imported by the node:test runner).
//
// Design principle (see design.md): integration-first. A connected, no-code
// integration beats hand-written instrumentation for time-to-value, so the
// no-code integrations (AWS, Cloudflare) come first and the "I'm hosted
// elsewhere" fallback — which routes to the coding-agent prompt — comes last.

// What activating a row does. `null` => not yet available (coming soon), so the
// row renders disabled and is not actionable. "code" opens the coding-agent
// prompt (paste into Cursor / Claude Code / Codex).
export type ConnectAction = "aws" | "cloudflare" | "code";

// Glyph key resolved to a neutral monochrome icon by the component. Kept as a
// string union (not a component) so this module stays free of JSX/React.
export type ConnectIcon = "aws" | "cloudflare" | "terminal";

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
        id: "elsewhere",
        title: "I'm hosted elsewhere",
        description:
          "Vercel, Fly, a VM, your laptop — anywhere. Paste a prompt into Cursor, Claude Code, or Codex and it installs the SDK, instruments your app, and opens a PR.",
        icon: "terminal",
        action: "code",
      },
    ],
  },
];

// Runtime availability for connectors that depend on server-side config. The
// backend self-disables the Cloudflare connector when its OAuth client / OTLP
// intake env isn't set (see system-capabilities), so the chooser must not offer
// a click that would 503 — it renders the tile as "coming soon" until the API
// reports the connector is configured.
export type ConnectAvailability = {
  cloudflare: boolean;
};

export function connectSectionsFor(availability: ConnectAvailability): ConnectSection[] {
  if (availability.cloudflare) return CONNECT_SECTIONS;
  return CONNECT_SECTIONS.map((section) => ({
    ...section,
    options: section.options.map((option) =>
      option.id === "cloudflare"
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
