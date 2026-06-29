// Settings navigation model: two scopes (org / project) rendered as top
// tabs, each with a grouped icon sidebar. Pure data + resolution logic so
// the IA is testable without rendering.

export type SettingsScope = "org" | "project";

export type SettingsProject = {
  id: string;
  name: string;
};

export type OrgSectionId =
  | "general"
  | "members"
  | "billing"
  | "agent-guidance"
  | "mgmt-keys"
  | "github-install";

export type ProjectSectionId =
  | "general"
  | "agent"
  | "agent-memories"
  | "integrations"
  | "issue-filter"
  | "ingest-parsing"
  | "slack-channel"
  | "api-keys"
  | "mcp-tokens"
  | "webhooks";

export type SectionId = OrgSectionId | ProjectSectionId;

export type NavGroup<Id extends string> = {
  // Undefined for the primary group; "More" for the secondary one.
  label?: string;
  items: ReadonlyArray<{ id: Id; label: string }>;
};

export const NEW_PROJECT_OPTION_VALUE = "__new_project__";

export const ORG_NAV_GROUPS: ReadonlyArray<NavGroup<OrgSectionId>> = [
  {
    items: [
      { id: "general", label: "General" },
      { id: "members", label: "Members" },
      { id: "billing", label: "Billing" },
      { id: "agent-guidance", label: "Agent guidance" },
    ],
  },
  {
    label: "More",
    items: [
      { id: "mgmt-keys", label: "API keys" },
      { id: "github-install", label: "GitHub" },
    ],
  },
];

export const PROJECT_NAV_GROUPS: ReadonlyArray<NavGroup<ProjectSectionId>> = [
  {
    items: [
      { id: "general", label: "General" },
      { id: "agent", label: "Agent" },
      { id: "agent-memories", label: "Agent memories" },
      { id: "integrations", label: "Integrations" },
      { id: "issue-filter", label: "Issue filter" },
      { id: "ingest-parsing", label: "Ingest & parsing" },
      { id: "slack-channel", label: "Slack channel" },
    ],
  },
  {
    label: "More",
    items: [
      { id: "api-keys", label: "API keys" },
      { id: "mcp-tokens", label: "MCP tokens" },
      { id: "webhooks", label: "Webhooks" },
    ],
  },
];

const ORG_SECTION_IDS = new Set<string>(ORG_NAV_GROUPS.flatMap((g) => g.items.map((i) => i.id)));
const PROJECT_SECTION_IDS = new Set<string>(
  PROJECT_NAV_GROUPS.flatMap((g) => g.items.map((i) => i.id)),
);

// Sections that used to be their own page and now live inside another one.
const LEGACY_ORG_SECTION_ALIASES: Record<string, OrgSectionId> = {
  "weekly-digest": "general",
};

export function resolveOrgSection(param: string | undefined): OrgSectionId {
  if (!param) return "general";
  const alias = LEGACY_ORG_SECTION_ALIASES[param];
  if (alias) return alias;
  return ORG_SECTION_IDS.has(param) ? (param as OrgSectionId) : "general";
}

export function resolveProjectSection(param: string | undefined): ProjectSectionId {
  if (!param) return "general";
  return PROJECT_SECTION_IDS.has(param) ? (param as ProjectSectionId) : "general";
}

export function shouldShowProjectPicker(scope: SettingsScope): boolean {
  return scope === "project";
}

export function projectPickerOptions(projects: ReadonlyArray<SettingsProject>) {
  return [
    ...projects.map((p) => ({ value: p.id, label: p.name, searchText: p.name })),
    { value: NEW_PROJECT_OPTION_VALUE, label: "+ New project", searchText: "new project" },
  ];
}

export function nextProjectIdAfterDelete(
  projects: ReadonlyArray<SettingsProject>,
  deletedProjectId: string,
): string | undefined {
  const deletedIndex = projects.findIndex((p) => p.id === deletedProjectId);
  const remaining = projects.filter((p) => p.id !== deletedProjectId);
  if (remaining.length === 0) return undefined;
  if (deletedIndex < 0) return remaining[0]?.id;
  return remaining[Math.min(deletedIndex, remaining.length - 1)]?.id;
}

// Which org to switch to after deleting one — pick the neighbour at the same
// position, mirroring nextProjectIdAfterDelete. Returns undefined only if no
// orgs remain (which the delete endpoint forbids, but keep the UI defensive).
export function nextOrgIdAfterDelete(
  orgs: ReadonlyArray<{ id: string }>,
  deletedOrgId: string,
): string | undefined {
  const deletedIndex = orgs.findIndex((o) => o.id === deletedOrgId);
  const remaining = orgs.filter((o) => o.id !== deletedOrgId);
  if (remaining.length === 0) return undefined;
  if (deletedIndex < 0) return remaining[0]?.id;
  return remaining[Math.min(deletedIndex, remaining.length - 1)]?.id;
}
