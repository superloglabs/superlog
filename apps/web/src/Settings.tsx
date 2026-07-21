import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  type AgentSettings,
  type AutoMergeMethod,
  type AutoMergePolicy,
  type CloudConnection,
  EMPTY_ISSUE_FILTER_CONFIG,
  type Integration,
  type IssueFilterClause,
  type IssueFilterConfig,
  type IssueFilterPreviewEvent,
  type LinearTicketInstruction,
  type PrPolicy,
  type RenderOwner,
  type RepoBranch,
  type StackComponent,
  type WebhookDelivery,
  type WebhookEndpoint,
  useAgentSettings,
  useCloudConnections,
  useCloudStackHealth,
  useCloudflareInstallation,
  useCloudflareWorkers,
  useConnectRender,
  useCreateCloudConnection,
  useCreateKey,
  useCreateMcpToken,
  useCreateOrgProject,
  useCreateWebhook,
  useDeleteCloudConnection,
  useDeleteOrgProject,
  useDeleteSlackRoute,
  useDeleteWebhook,
  useGcpConnection,
  useGithubBranches,
  useGithubInstallation,
  useGrantOrgRepoToProject,
  useIngestFilters,
  useIntegrations,
  useIssueFilterAttributeKeys,
  useIssueFilterAttributeValues,
  useIssueFilterPreview,
  useKeys,
  useLinearInstallation,
  useMcpTokens,
  useMe,
  useMintOrgApiKey,
  useMintOrgGithubInstallUrl,
  useNotionInstallation,
  useOrgAgentSettings,
  useOrgApiKeys,
  useOrgGithubInstallGrants,
  useOrgGithubInstallRepos,
  useOrgGithubInstallations,
  useOrgProjects,
  useProjectDigest,
  useRailwayInstallation,
  useRedeliverWebhook,
  useRemoveIntegration,
  useRenderInstallation,
  useRenderOwners,
  useResetGithubCommitAuthor,
  useRevokeKey,
  useRevokeMcpToken,
  useRevokeOrgApiKey,
  useRevokeOrgGithubInstallation,
  useRevokeOrgRepoFromProject,
  useRotateWebhookSecret,
  useRunProjectDigestNow,
  useSaveAgentSettings,
  useSaveIntegration,
  useSaveOrgAgentSettings,
  useSaveProjectDigest,
  useSetCloudflareAutoWire,
  useSetIngestFilters,
  useSetSlackRoute,
  useSetupCloudStream,
  useSlackChannels,
  useSlackInstallation,
  useSlackRoute,
  useStartCloudflareInstall,
  useStartGcpConnect,
  useStartGithubAccessLogin,
  useStartGithubAuthorLogin,
  useStartGithubInstall,
  useStartLinearInstall,
  useStartNotionInstall,
  useStartRailwayInstall,
  useStartSlackInstall,
  useStartVercelInstall,
  useSystemCapabilities,
  useTestWebhook,
  useUninstallCloudflare,
  useUninstallLinear,
  useUninstallNotion,
  useUninstallRailway,
  useUninstallRender,
  useUninstallSlack,
  useUninstallVercel,
  useUnwireCloudflareWorker,
  useUpdateGithubRepoAccess,
  useUpdateOrgProject,
  useUpdateWebhook,
  useVercelInstallation,
  useVerifyCloudConnection,
  useWebhookDeliveries,
  useWebhooks,
  useWireAllCloudflareWorkers,
  useWireCloudflareWorker,
} from "./api";
import { AWS_REGIONS } from "./awsRegions.ts";
import { Dropdown, type DropdownOption } from "./design/Dropdown.tsx";
import {
  Btn,
  Chip,
  DataList,
  DataListCell,
  DataListHeader,
  DataListHeaderCell,
  DataListRow,
  FieldLabel,
  Input,
  Label,
  PageHeader,
  SkeletonBlock,
  Tile,
} from "./design/ui";
import { gcpConnectAction } from "./gcp-settings-model.ts";
import { McpInstallPanel } from "./onboarding/McpInstallDialog.tsx";
import { useDemoExploration } from "./onboarding/demoExploration.tsx";
import {
  AwsIcon,
  CloudflareIcon,
  GcpIcon,
  GithubIcon,
  InfoIcon,
  OtelIcon,
  RailwayIcon,
  RenderIcon,
  SlackIcon,
  VercelIcon,
} from "./onboarding/icons.tsx";
import { renderErrorMessage } from "./onboarding/renderConnectModel.ts";
import { VERCEL_PLAN_REQUIREMENT } from "./onboarding/vercelConnectModel.ts";
import { AgentMcpServersCard } from "./settings/AgentMcpServersCard.tsx";
import { AgentMemoriesCard } from "./settings/AgentMemoriesCard.tsx";
import { BillingCard } from "./settings/BillingCard.tsx";
import { CreateOrgCard } from "./settings/CreateOrgCard.tsx";
import { IntegrationConfigDialog } from "./settings/IntegrationConfigDialog.tsx";
import { InactiveIncidentResolutionCard } from "./settings/InactiveIncidentResolutionCard.tsx";
import { OrgDangerCard } from "./settings/OrgDangerCard.tsx";
import { OrgGeneralCard } from "./settings/OrgGeneralCard.tsx";
import { OrgMembersCard } from "./settings/OrgMembersCard.tsx";
import { PorterIntegrationSetup } from "./settings/PorterIntegrationSetup.tsx";
import { Toggle } from "./settings/Toggle.tsx";
import {
  type IngestSignal,
  type IngestSource,
  isIngestSignalEnabled,
  updateIngestSignal,
} from "./settings/ingestFiltersModel.ts";
import {
  type IntegrationCatalogItem,
  filterAvailableIntegrations,
  partitionIntegrations,
} from "./settings/integrationsCatalogModel.ts";
import {
  NEW_PROJECT_OPTION_VALUE,
  ORG_NAV_GROUPS,
  type OrgSectionId,
  PROJECT_NAV_GROUPS,
  type ProjectSectionId,
  type SectionId,
  type SettingsScope,
  nextProjectIdAfterDelete,
  projectPickerOptions,
  resolveOrgSection,
  resolveProjectSection,
  sectionIconKind,
  shouldShowProjectPicker,
} from "./settings/nav.ts";
import {
  SettingsCard,
  SettingsCardFooter,
  SettingsRow,
  SettingsSectionHeader,
} from "./settings/rows.tsx";
import {
  weeklyDigestChannelSelection,
  weeklyDigestStatusDescription,
  weeklyDigestToggleDisabled,
} from "./weekly-digest-controls.ts";

type NavTarget = {
  scope?: SettingsScope;
  projectId?: string | null;
  section?: SectionId;
};

export function Settings() {
  const [params, setParams] = useSearchParams();
  const linearStatus = params.get("linear");
  const notionStatus = params.get("notion");
  const githubStatus = params.get("github");
  const githubAuthorStatus = params.get("github_author");
  const mcpOAuthStatus = params.get("mcp_oauth");

  useEffect(() => {
    if (!linearStatus && !notionStatus && !githubStatus && !githubAuthorStatus && !mcpOAuthStatus)
      return;
    const t = setTimeout(() => {
      params.delete("linear");
      params.delete("notion");
      params.delete("github");
      params.delete("github_author");
      params.delete("mcp_oauth");
      setParams(params, { replace: true });
    }, 4000);
    return () => clearTimeout(t);
  }, [
    linearStatus,
    notionStatus,
    githubStatus,
    githubAuthorStatus,
    mcpOAuthStatus,
    params,
    setParams,
  ]);

  const me = useMe();
  const projectsQ = useOrgProjects();
  const projects = projectsQ.data?.projects ?? [];
  const defaultProjectId = me.data?.project?.id;

  const scope: SettingsScope = params.get("scope") === "org" ? "org" : "project";
  const projectIdParam = params.get("projectId") ?? undefined;
  const sectionParam = params.get("section") ?? undefined;

  const activeProjectId = useMemo(() => {
    if (scope !== "project") return undefined;
    if (projectIdParam && projects.some((p) => p.id === projectIdParam)) return projectIdParam;
    if (defaultProjectId && projects.some((p) => p.id === defaultProjectId))
      return defaultProjectId;
    return projects[0]?.id;
  }, [scope, projectIdParam, projects, defaultProjectId]);

  const activeSection: SectionId = useMemo(() => {
    return scope === "org" ? resolveOrgSection(sectionParam) : resolveProjectSection(sectionParam);
  }, [scope, sectionParam]);

  const navigate = (next: NavTarget) => {
    const updated = new URLSearchParams(params);
    if (next.scope) {
      if (next.scope === "project") updated.delete("scope");
      else updated.set("scope", next.scope);
    }
    if (next.projectId !== undefined) {
      if (next.projectId) updated.set("projectId", next.projectId);
      else updated.delete("projectId");
    }
    if (next.section) updated.set("section", next.section);
    setParams(updated, { replace: true });
  };

  const [creatingProject, setCreatingProject] = useState(false);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Manage the project, organization, integrations, and investigation defaults."
      />
      {(linearStatus || notionStatus || githubStatus || githubAuthorStatus || mcpOAuthStatus) && (
        <header className="space-y-2">
          {linearStatus && <LinearStatusBanner status={linearStatus} />}
          {notionStatus && <NotionStatusBanner status={notionStatus} />}
          {githubStatus && <GithubStatusBanner status={githubStatus} />}
          {githubAuthorStatus && <GithubAuthorStatusBanner status={githubAuthorStatus} />}
          {mcpOAuthStatus && (
            <div className="pt-1">
              <Chip tone={mcpOAuthStatus === "connected" ? "success" : "danger"} dot>
                {mcpOAuthStatus === "connected"
                  ? "Agent MCP connected."
                  : "Agent MCP OAuth failed."}
              </Chip>
            </div>
          )}
        </header>
      )}

      <SettingsTabs
        scope={scope}
        projects={projects}
        activeProjectId={activeProjectId}
        onNavigate={navigate}
        onCreateProject={() => setCreatingProject(true)}
      />

      <div className="flex flex-col gap-8 md:flex-row md:items-start">
        <SettingsSideNav scope={scope} section={activeSection} onNavigate={navigate} />
        <div className="min-w-0 flex-1">
          {creatingProject && (
            <div className="mb-6 max-w-sm rounded-lg border border-border bg-surface p-3">
              <p className="mb-2 text-[13px] font-medium text-fg">New project</p>
              <NewProjectForm
                onCancel={() => setCreatingProject(false)}
                onCreated={(p) => {
                  setCreatingProject(false);
                  navigate({ scope: "project", projectId: p.id, section: "general" });
                }}
              />
            </div>
          )}
          {scope === "org" ? (
            <OrgSectionView section={activeSection as OrgSectionId} />
          ) : (
            <ProjectSectionView
              section={activeSection as ProjectSectionId}
              projectId={activeProjectId}
              onProjectDeleted={(nextProjectId) => {
                navigate({
                  scope: "project",
                  projectId: nextProjectId ?? null,
                  section: "general",
                });
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function SettingsTabs({
  scope,
  projects,
  activeProjectId,
  onNavigate,
  onCreateProject,
}: {
  scope: SettingsScope;
  projects: Array<{ id: string; name: string }>;
  activeProjectId: string | undefined;
  onNavigate: (target: NavTarget) => void;
  onCreateProject: () => void;
}) {
  const pickerOptions: DropdownOption[] = projectPickerOptions(projects);
  return (
    <div className="flex items-end gap-7 border-b border-border">
      <TabButton
        label="Organization"
        active={scope === "org"}
        onClick={() => onNavigate({ scope: "org", section: "general" })}
      />
      <TabButton
        label="Project"
        active={scope === "project"}
        onClick={() => onNavigate({ scope: "project", section: "general" })}
      />
      <div className="flex-1" />
      {shouldShowProjectPicker(scope) && (
        <div className="pb-2">
          <Dropdown
            value={activeProjectId ?? ""}
            onChange={(v) => {
              if (v === NEW_PROJECT_OPTION_VALUE) {
                onCreateProject();
                return;
              }
              onNavigate({ scope: "project", projectId: v });
            }}
            options={pickerOptions}
            searchable={projects.length > 6}
            className="w-52"
          />
        </div>
      )}
    </div>
  );
}

function TabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`-mb-px border-b-2 pb-2.5 pt-1 text-[14px] transition-colors ${
        active
          ? "border-fg font-semibold text-fg"
          : "border-transparent font-medium text-muted hover:text-fg"
      }`}
    >
      {label}
    </button>
  );
}

function SettingsSideNav({
  scope,
  section,
  onNavigate,
}: {
  scope: SettingsScope;
  section: SectionId;
  onNavigate: (target: NavTarget) => void;
}) {
  const { exploring } = useDemoExploration();
  const rawGroups = scope === "org" ? ORG_NAV_GROUPS : PROJECT_NAV_GROUPS;
  // Billing is blocked while exploring demo data (no real project to bill yet),
  // so drop its tab from the org sidebar.
  const groups = exploring
    ? rawGroups.map((g) => ({ ...g, items: g.items.filter((i) => i.id !== "billing") }))
    : rawGroups;
  return (
    <nav className="shrink-0 md:sticky md:top-6 md:w-56">
      <ul className="flex flex-col gap-0.5">
        {groups.map((group, gi) => (
          <li key={group.label ?? gi}>
            {group.label && (
              <p className="mb-1 mt-5 px-3 text-[11px] font-medium text-subtle">{group.label}</p>
            )}
            <ul className="flex flex-col gap-0.5">
              {group.items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => onNavigate({ scope, section: item.id })}
                    className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-[13px] transition-colors ${
                      section === item.id
                        ? "bg-surface-2 text-fg"
                        : "text-muted hover:bg-surface-2 hover:text-fg"
                    }`}
                  >
                    <span className="flex h-4 w-4 items-center justify-center" aria-hidden>
                      <SectionIcon scope={scope} section={item.id} />
                    </span>
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function SectionIcon({ scope, section }: { scope: SettingsScope; section: SectionId }) {
  const props = {
    width: 16,
    height: 16,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  } as const;
  const key = sectionIconKind(scope, section);
  switch (key) {
    case "org:general":
    case "project:general":
      return (
        <svg {...props} aria-hidden="true">
          <line x1="4" y1="8" x2="20" y2="8" />
          <line x1="4" y1="16" x2="20" y2="16" />
          <circle cx="9" cy="8" r="2" />
          <circle cx="15" cy="16" r="2" />
        </svg>
      );
    case "org:members":
      return (
        <svg {...props} aria-hidden="true">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      );
    case "org:billing":
      return (
        <svg {...props} aria-hidden="true">
          <rect x="1" y="4" width="22" height="16" rx="2" />
          <line x1="1" y1="10" x2="23" y2="10" />
        </svg>
      );
    case "agent":
      return (
        <svg {...props} aria-hidden="true">
          <path d="M12 3a7 7 0 0 1 7 7v3a7 7 0 0 1-14 0v-3a7 7 0 0 1 7-7z" />
          <circle cx="9" cy="12" r="0.5" fill="currentColor" />
          <circle cx="15" cy="12" r="0.5" fill="currentColor" />
        </svg>
      );
    case "project:agent-memories":
      return (
        <svg {...props} aria-hidden="true">
          <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
          <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
          <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
          <path d="M6 18a4 4 0 0 1-1.967-.516" />
          <path d="M19.967 17.484A4 4 0 0 1 18 18" />
        </svg>
      );
    case "mcp-server":
      return (
        <svg {...props} aria-hidden="true">
          <rect x="3" y="3" width="18" height="7" rx="2" />
          <rect x="3" y="14" width="18" height="7" rx="2" />
          <circle cx="7" cy="6.5" r="0.75" fill="currentColor" stroke="none" />
          <circle cx="7" cy="17.5" r="0.75" fill="currentColor" stroke="none" />
          <path d="M11 6.5h6" />
          <path d="M11 17.5h6" />
        </svg>
      );
    case "org:mgmt-keys":
    case "project:api-keys":
      return (
        <svg {...props} aria-hidden="true">
          <circle cx="7.5" cy="15.5" r="5.5" />
          <path d="m21 2-9.6 9.6" />
          <path d="m15.5 7.5 3 3L22 7l-3-3" />
        </svg>
      );
    case "org:github-install":
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
        </svg>
      );
    case "project:integrations":
      return (
        <svg {...props} aria-hidden="true">
          <path d="M9 2v6" />
          <path d="M15 2v6" />
          <path d="M6 8h12v4a6 6 0 0 1-12 0V8z" />
          <path d="M12 18v4" />
        </svg>
      );
    case "project:ingestion":
      return (
        <svg {...props} aria-hidden="true">
          <ellipse cx="12" cy="5" rx="8" ry="3" />
          <path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
          <path d="M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" />
        </svg>
      );
    case "project:mcp-install":
      return (
        <svg {...props} aria-hidden="true">
          <path d="M12 3v12" />
          <path d="m8 11 4 4 4-4" />
          <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
        </svg>
      );
    case "project:mcp-tokens":
      return (
        <svg {...props} aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="m7 9 3 3-3 3" />
          <path d="M13 15h4" />
        </svg>
      );
    case "project:issue-filter":
      return (
        <svg {...props} aria-hidden="true">
          <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />
        </svg>
      );
    case "project:slack-channel":
      return (
        <svg {...props} aria-hidden="true">
          <line x1="10" y1="3" x2="7" y2="21" />
          <line x1="17" y1="3" x2="14" y2="21" />
          <line x1="3" y1="9" x2="21" y2="9" />
          <line x1="3" y1="15" x2="21" y2="15" />
        </svg>
      );
    case "project:webhooks":
      return (
        <svg {...props} aria-hidden="true">
          <path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2" />
          <path d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06" />
          <path d="m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8" />
        </svg>
      );
    default:
      return null;
  }
}

function NewProjectForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (project: { id: string; name: string; slug: string }) => void;
}) {
  const [name, setName] = useState("");
  const create = useCreateOrgProject();
  const [error, setError] = useState<string | null>(null);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setError(null);
    create.mutate(
      { name: trimmed },
      {
        onSuccess: (res) => {
          setName("");
          onCreated(res.project);
        },
        onError: (err) => setError(err instanceof Error ? err.message : String(err)),
      },
    );
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-1 px-2">
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
        }}
        placeholder="Project name"
        disabled={create.isPending}
        className="h-7 w-full rounded-lg border border-border bg-surface-2 px-2 text-[13px] text-fg focus:border-border-strong focus:outline-none"
      />
      {error && <span className="px-1 text-[11px] text-danger">{error}</span>}
      <div className="flex items-center gap-1">
        <Btn type="submit" size="sm" loading={create.isPending} disabled={!name.trim()}>
          Create
        </Btn>
        <Btn type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Btn>
      </div>
    </form>
  );
}

function OrgSectionView({ section }: { section: OrgSectionId }) {
  const { exploring } = useDemoExploration();
  // Billing is unavailable while exploring demo data — guard the section in case
  // it's reached by a deep link (the sidebar tab is already hidden).
  if (section === "billing" && exploring) {
    return (
      <Section
        title="Billing"
        subtitle="Your plan, usage this period, and payment — billed per org."
      >
        <Tile>
          <p className="text-[13px] text-muted">
            Billing is unavailable while you’re exploring demo data. Connect your app to start
            sending your own telemetry, then manage your plan here.
          </p>
        </Tile>
      </Section>
    );
  }
  switch (section) {
    case "general":
      return (
        <div className="space-y-10">
          <Section
            title="General"
            subtitle="Organization name and slug. Visible to everyone in the org."
          >
            <OrgGeneralCard />
          </Section>
          <Section
            title="Create organization"
            subtitle="Spin up another organization — useful for separating teams, clients, or environments."
          >
            <CreateOrgCard />
          </Section>
          <Section title="Danger zone" subtitle="Irreversible actions for this organization.">
            <OrgDangerCard />
          </Section>
        </div>
      );
    case "members":
      return (
        <Section title="Members" subtitle="Invite teammates, change roles, and remove access.">
          <OrgMembersCard />
        </Section>
      );
    case "billing":
      return (
        <Section
          title="Billing"
          subtitle="Your plan, usage this period, and payment — billed per org."
        >
          <BillingCard />
        </Section>
      );
    case "agent-guidance":
      return (
        <Section
          title="Org-wide agent guidance"
          subtitle="Prepended to every agent run prompt across all projects in this org."
        >
          <OrgGuidanceCard />
        </Section>
      );
    case "mgmt-keys":
      return (
        <Section
          title="Management API keys"
          subtitle="Org-scoped keys for the provisioning API at /api/v1/*. Use these from your backend to create projects and mint ingest keys programmatically."
        >
          <OrgApiKeysCard />
        </Section>
      );
    case "github-install":
      return (
        <Section
          title="Org-level GitHub install"
          subtitle="For platform-style customers managing many projects under one Superlog org. Installs Superlog's GitHub App on your GitHub org once; per-project repo grants are then managed via the management API."
        >
          <OrgGithubInstallCard />
        </Section>
      );
  }
}

function ProjectSectionView({
  section,
  projectId,
  onProjectDeleted,
}: {
  section: ProjectSectionId;
  projectId: string | undefined;
  onProjectDeleted: (nextProjectId: string | undefined) => void;
}) {
  switch (section) {
    case "general":
      return (
        <Section
          title="General"
          subtitle="Project name, slug, and context available to investigations."
        >
          <ProjectGeneralCard projectId={projectId} onDeleted={onProjectDeleted} />
        </Section>
      );
    case "integrations":
      return (
        <Section
          title="Integrations"
          subtitle="Manage connected services and discover new ways to bring project context and telemetry into Superlog."
        >
          <IntegrationsBento projectId={projectId} />
        </Section>
      );
    case "ingestion":
      return (
        <Section
          title="Data controls"
          subtitle="Choose which telemetry each connected source is allowed to ingest."
        >
          <IngestSourcesCard projectId={projectId} />
        </Section>
      );
    case "agent":
      return (
        <Section
          title="Bug-investigating agent"
          subtitle="Configure the investigation flow and automatic incident lifecycle policies."
        >
          <div className="flex flex-col gap-8">
            <AgentFlowchart projectId={projectId} />
            <InactiveIncidentResolutionSettings projectId={projectId} />
          </div>
        </Section>
      );
    case "agent-memories":
      return (
        <Section
          title="Agent memories"
          subtitle="Durable facts the investigation agent carries across runs of this project — terminology, infra layout, lessons from your feedback. The agent saves these itself; review and prune them here."
        >
          <AgentMemoriesCard projectId={projectId} />
        </Section>
      );
    case "agent-mcps":
      return (
        <Section
          title="Agent MCP servers"
          subtitle="Project-scoped tools attached to new investigation and Slack-agent sessions. Superlog telemetry occupies the reserved twentieth provider slot."
        >
          <AgentMcpServersCard projectId={projectId} />
        </Section>
      );
    case "issue-filter":
      return (
        <Section
          title="Error filter"
          subtitle="Drop error logs and traces whose attributes don't match before they create errors."
        >
          <IssueFilterCard projectId={projectId} />
        </Section>
      );
    case "slack-channel":
      return (
        <Section
          title="Slack channel"
          subtitle="Where this project's incident threads and weekly fixes digest are posted."
        >
          <div className="flex flex-col gap-8">
            <SlackRoutingCard projectId={projectId} />
            <div className="space-y-4">
              <SettingsSectionHeader
                title="Weekly recap"
                subtitle="A weekly Slack recap of this project's top 3 pending bug-fix PRs, ranked by an LLM."
              />
              <WeeklyDigestCard projectId={projectId} />
            </div>
          </div>
        </Section>
      );
    case "api-keys":
      return (
        <Section
          title="API keys"
          subtitle="Project-scoped ingest keys for the OpenTelemetry exporter and CLI."
        >
          <ApiKeysCard projectId={projectId} />
        </Section>
      );
    case "mcp-install":
      return (
        <Section
          title="Install MCP server"
          subtitle="Connect an MCP-aware agent to Superlog. Pick your agent below — the first connect runs a browser OAuth flow, no token required."
        >
          <Tile>
            <McpInstallPanel />
          </Tile>
        </Section>
      );
    case "mcp-tokens":
      return (
        <Section
          title="MCP tokens"
          subtitle="Personal access tokens for the Superlog MCP server — an alternative to the browser OAuth flow. Paste one into your agent as a static Authorization header."
        >
          <McpTokensCard projectId={projectId} />
        </Section>
      );
    case "webhooks":
      return (
        <Section
          title="Webhooks"
          subtitle="Receive an HTTP POST when an agent run completes. Signed with HMAC-SHA256."
        >
          <WebhooksCard projectId={projectId} />
        </Section>
      );
  }
}

const PROJECT_CONTEXT_MAX_LEN = 8000;

function ProjectGeneralCard({
  projectId,
  onDeleted,
}: {
  projectId: string | undefined;
  onDeleted: (nextProjectId: string | undefined) => void;
}) {
  const projectsQ = useOrgProjects();
  const update = useUpdateOrgProject();
  const del = useDeleteOrgProject();
  const projects = projectsQ.data?.projects ?? [];
  const project = projects.find((p) => p.id === projectId) ?? null;
  const value = project?.projectContext ?? "";
  const [draft, setDraft] = useState(value);
  const [nameDraft, setNameDraft] = useState(project?.name ?? "");
  const [loadedProjectId, setLoadedProjectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedTick, setSavedTick] = useState(false);

  useEffect(() => {
    if (!project) return;
    if (loadedProjectId === project.id) return;
    setDraft(project.projectContext);
    setNameDraft(project.name);
    setLoadedProjectId(project.id);
    setError(null);
  }, [loadedProjectId, project]);

  const loaded = !!project && loadedProjectId === project.id;
  const nameDirty = loaded && nameDraft.trim() !== project.name && nameDraft.trim().length > 0;
  const dirty = (loaded && draft !== value) || nameDirty;
  const disabled = !loaded || projectsQ.isLoading || update.isPending;
  const canDelete = projects.length > 1;

  return (
    <div className="space-y-4">
      <SettingsCard>
        <SettingsRow
          title="Name"
          description="Shown across the app and in incident threads"
          control={
            <div className="w-60">
              <Input
                value={nameDraft}
                disabled={disabled}
                onChange={(e) => setNameDraft(e.target.value)}
              />
            </div>
          }
        />
        <SettingsRow
          title="Slug"
          description="Used in URLs — fixed after creation"
          control={
            <div className="w-60">
              <Input className="font-sans text-[12.5px]" value={project?.slug ?? ""} disabled />
            </div>
          }
        />
        <SettingsRow
          title="Project context"
          description="Included as project context for investigations in this project"
        >
          <textarea
            value={draft}
            disabled={disabled}
            onChange={(e) => setDraft(e.target.value.slice(0, PROJECT_CONTEXT_MAX_LEN))}
            rows={7}
            placeholder="e.g. This project is the billing API. Stripe customer IDs are org-scoped. Prefer touching packages/billing before app code."
            className="w-full rounded-lg border border-border bg-surface-2 p-3 font-sans text-[12.5px] text-fg placeholder:text-subtle focus:border-border-strong focus:outline-none disabled:opacity-60"
          />
          <div className="mt-1 flex justify-end font-sans text-[12px] tabular-nums text-muted">
            {draft.length} / {PROJECT_CONTEXT_MAX_LEN}
          </div>
        </SettingsRow>
        <SettingsCardFooter>
          {error && <span className="mr-auto text-[12px] text-danger">{error}</span>}
          {savedTick && <span className="text-[12px] text-success">Saved</span>}
          {dirty && (
            <Btn
              size="sm"
              variant="ghost"
              disabled={update.isPending}
              onClick={() => {
                setDraft(value);
                setNameDraft(project?.name ?? "");
              }}
            >
              Discard
            </Btn>
          )}
          <Btn
            size="sm"
            variant="primary"
            disabled={!dirty || disabled}
            loading={update.isPending}
            onClick={() => {
              if (!project || !loaded) return;
              setError(null);
              update.mutate(
                {
                  projectId: project.id,
                  patch: {
                    projectContext: draft,
                    ...(nameDirty ? { name: nameDraft.trim() } : {}),
                  },
                },
                {
                  onSuccess: () => {
                    setSavedTick(true);
                    setTimeout(() => setSavedTick(false), 1500);
                  },
                  onError: (err) => setError(err instanceof Error ? err.message : String(err)),
                },
              );
            }}
          >
            Save
          </Btn>
        </SettingsCardFooter>
      </SettingsCard>

      <SettingsCard>
        <SettingsRow
          title="Delete project"
          description="Telemetry, API keys, and integrations for this project will be deleted. This cannot be undone."
          control={
            <Btn
              size="sm"
              variant="danger"
              disabled={!project || !canDelete || del.isPending}
              loading={del.isPending}
              onClick={() => {
                if (!project || !canDelete) return;
                const ok = window.confirm(
                  `Delete project "${project.name}"? Telemetry, API keys, and integrations for this project will be deleted. This cannot be undone.`,
                );
                if (!ok) return;
                const nextProjectId = nextProjectIdAfterDelete(projects, project.id);
                del.mutate(project.id, {
                  onSuccess: () => {
                    onDeleted(nextProjectId);
                  },
                  onError: (err) => {
                    window.alert(
                      `Delete failed: ${err instanceof Error ? err.message : String(err)}`,
                    );
                  },
                });
              }}
            >
              Delete
            </Btn>
          }
        />
      </SettingsCard>
    </div>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4">
      <SettingsSectionHeader title={title} subtitle={subtitle} />
      {children}
    </section>
  );
}

function LinearStatusBanner({ status }: { status: string }) {
  const tone = status === "installed" ? "success" : status === "denied" ? "warning" : "danger";
  const text =
    status === "installed"
      ? "Linear connected."
      : status === "denied"
        ? "Linear authorization was denied."
        : "Linear connection failed. Try again.";
  return (
    <div className="pt-1">
      <Chip tone={tone} dot>
        {text}
      </Chip>
    </div>
  );
}

function NotionStatusBanner({ status }: { status: string }) {
  const tone = status === "installed" ? "success" : status === "denied" ? "warning" : "danger";
  const text =
    status === "installed"
      ? "Notion connected."
      : status === "denied"
        ? "Notion authorization was denied."
        : "Notion connection failed. Try again.";
  return (
    <div className="pt-1">
      <Chip tone={tone} dot>
        {text}
      </Chip>
    </div>
  );
}

function GithubStatusBanner({ status }: { status: string }) {
  const tone = status === "connected" ? "success" : status === "no_install" ? "warning" : "danger";
  const text =
    status === "connected"
      ? "GitHub access refreshed."
      : status === "no_install"
        ? "Install the GitHub App to grant repository access."
        : "GitHub connection failed. Try again.";
  return (
    <div className="pt-1">
      <Chip tone={tone} dot>
        {text}
      </Chip>
    </div>
  );
}

function GithubAuthorStatusBanner({ status }: { status: string }) {
  const tone = status === "connected" ? "success" : status === "denied" ? "warning" : "danger";
  const text =
    status === "connected"
      ? "GitHub commit author switched to the app installer."
      : status === "denied"
        ? "GitHub authorization was denied."
        : status === "no_install"
          ? "Install the GitHub App before using the app installer as author."
          : "GitHub commit author connection failed. Try again.";
  return (
    <div className="pt-1">
      <Chip tone={tone} dot>
        {text}
      </Chip>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Integration cards
// ---------------------------------------------------------------------------

type ProjectIntegrationId =
  | "github"
  | "slack"
  | "linear"
  | "notion"
  | "cloudflare"
  | "vercel"
  | "railway"
  | "render"
  | "gcp"
  | "aws"
  | "porter";

type IntegrationBentoItem = IntegrationCatalogItem & {
  id: ProjectIntegrationId;
  statusLabel: string;
};

function IntegrationsBento({ projectId }: { projectId: string | undefined }) {
  const github = useGithubInstallation();
  const slack = useSlackInstallation(projectId, !!projectId);
  const linear = useLinearInstallation();
  const notion = useNotionInstallation();
  const cloudflare = useCloudflareInstallation(projectId);
  const vercel = useVercelInstallation(projectId);
  const railway = useRailwayInstallation(projectId);
  const render = useRenderInstallation(projectId);
  const gcp = useGcpConnection(projectId);
  const aws = useCloudConnections(projectId);
  const keys = useKeys(projectId);

  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<ProjectIntegrationId | null>(null);

  const githubAccounts = github.data?.installed ? github.data.installations.length : 0;
  const railwayProjects = railway.data?.installed ? railway.data.grantedProjects.length : 0;
  const renderServices = render.data?.installed
    ? render.data.services.filter((service) => !service.suspended).length
    : 0;
  const awsConnections = aws.data ?? [];
  const connectedAws = awsConnections.some((connection) => connection.status === "connected");
  const porterKeys = (keys.data ?? []).filter(
    (key) => key.name === "Porter Helm install" && !key.revokedAt,
  );
  const connectedPorter = porterKeys.some((key) => key.lastUsedAt !== null);

  const items: IntegrationBentoItem[] = [
    {
      id: "github",
      name: "GitHub",
      description: "Open pull requests and control repository access for investigations.",
      category: "Developer tools",
      keywords: ["source control", "repositories", "pull requests", "code"],
      installed: github.data?.installed === true,
      statusLabel:
        githubAccounts > 0
          ? `${githubAccounts} ${githubAccounts === 1 ? "account" : "accounts"}`
          : "Connected",
    },
    {
      id: "slack",
      name: "Slack",
      description: "Post incident threads and keep investigation conversations moving.",
      category: "Collaboration",
      keywords: ["chat", "messages", "channels", "incidents"],
      installed: slack.data?.installed === true,
      statusLabel: slack.data?.installed ? (slack.data.teamName ?? "Workspace") : "Connected",
    },
    {
      id: "linear",
      name: "Linear",
      description: "File and update issues as the agent investigates an incident.",
      category: "Issue tracking",
      keywords: ["tickets", "issues", "project management"],
      installed: linear.data?.installed === true,
      statusLabel:
        linear.data?.installed && linear.data.needsReauth
          ? "Needs reconnect"
          : linear.data?.installed
            ? (linear.data.workspaceName ?? "Workspace")
            : "Connected",
    },
    {
      id: "notion",
      name: "Notion",
      description: "Give investigations access to shared runbooks and architecture notes.",
      category: "Knowledge",
      keywords: ["docs", "wiki", "runbooks", "documentation"],
      installed: notion.data?.installed === true,
      statusLabel:
        notion.data?.installed && notion.data.needsReauth
          ? "Needs reconnect"
          : notion.data?.installed
            ? (notion.data.workspaceName ?? "Workspace")
            : "Connected",
    },
    {
      id: "cloudflare",
      name: "Cloudflare",
      description: "Stream Workers traces, logs, and metrics through Observability destinations.",
      category: "Cloud & hosting",
      keywords: ["workers", "observability", "telemetry", "serverless"],
      installed: cloudflare.data?.installed === true,
      statusLabel: cloudflare.data?.installed
        ? (cloudflare.data.accountName ?? "Account")
        : "Connected",
    },
    {
      id: "vercel",
      name: "Vercel",
      description: "Bring deployment traces and logs in through managed drains.",
      category: "Cloud & hosting",
      keywords: ["deployments", "drains", "telemetry", "frontend"],
      installed: vercel.data?.installed === true,
      statusLabel: vercel.data?.installed ? (vercel.data.teamName ?? "Team") : "Connected",
    },
    {
      id: "railway",
      name: "Railway",
      description: "Import service logs and infrastructure metrics from selected projects.",
      category: "Cloud & hosting",
      keywords: ["deployments", "services", "logs", "metrics"],
      installed: railway.data?.installed === true,
      statusLabel: railwayProjects === 1 ? "1 project" : `${railwayProjects || 0} projects`,
    },
    {
      id: "render",
      name: "Render",
      description: "Connect a workspace to pull service logs and infrastructure metrics.",
      category: "Cloud & hosting",
      keywords: ["deployments", "services", "logs", "metrics"],
      installed: render.data?.installed === true,
      statusLabel: renderServices === 1 ? "1 service" : `${renderServices || 0} services`,
    },
    {
      id: "gcp",
      name: "Google Cloud",
      description: "Stream Cloud Logging and pull a bounded set of Cloud Monitoring metrics.",
      category: "Cloud & hosting",
      keywords: ["gcp", "google", "cloud logging", "cloud monitoring", "metrics"],
      installed: gcp.data?.connected === true,
      statusLabel:
        gcp.data && "status" in gcp.data && gcp.data.status !== "connected"
          ? "Setup in progress"
          : "Connected",
    },
    {
      id: "porter",
      name: "Porter",
      description: "Collect Kubernetes logs, metrics, events, and application OTLP signals.",
      category: "Cloud & hosting",
      keywords: ["kubernetes", "helm", "otel", "opentelemetry", "logs", "metrics", "traces"],
      installed: connectedPorter,
      statusLabel: "Connected",
    },
    {
      id: "aws",
      name: "AWS",
      description: "Inventory resources and stream CloudWatch telemetry through a read-only role.",
      category: "Cloud & hosting",
      keywords: ["amazon", "cloudwatch", "iam", "cloudformation", "metrics"],
      installed: awsConnections.length > 0,
      statusLabel: connectedAws ? "Connected" : "Setup in progress",
    },
  ];

  const { configured } = partitionIntegrations(items);
  const available = filterAvailableIntegrations(items, search);
  const statusesLoading = [
    github,
    slack,
    linear,
    notion,
    cloudflare,
    vercel,
    railway,
    render,
    gcp,
    aws,
    keys,
  ].some((query) => query.isLoading);
  const selectedItem = items.find((item) => item.id === selectedId);

  if (statusesLoading) {
    return <IntegrationsBentoSkeleton />;
  }

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className="text-[15px] font-medium text-fg">Configured</h2>
            <p className="mt-1 text-[12.5px] text-muted">
              Services already connected to this project.
            </p>
          </div>
          <span className="text-[12px] tabular-nums text-subtle">
            {configured.length} connected
          </span>
        </div>
        {configured.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {configured.map((item) => (
              <IntegrationBentoCard
                key={item.id}
                item={item}
                onSelect={() => setSelectedId(item.id)}
              />
            ))}
          </div>
        ) : (
          <Tile className="border-dashed py-8 text-center">
            <p className="text-[13px] font-medium text-fg">No integrations connected yet</p>
            <p className="mt-1 text-[12.5px] text-muted">
              Choose one from the catalog below to get started.
            </p>
          </Tile>
        )}
      </div>

      <div className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-[15px] font-medium text-fg">Add an integration</h2>
            <p className="mt-1 text-[12.5px] text-muted">
              Connect another source of context, collaboration, or telemetry.
            </p>
          </div>
          <div className="w-full sm:w-64">
            <Input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search integrations…"
              aria-label="Search integrations"
            />
          </div>
        </div>
        {available.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {available.map((item) => (
              <IntegrationBentoCard
                key={item.id}
                item={item}
                onSelect={() => setSelectedId(item.id)}
              />
            ))}
          </div>
        ) : (
          <Tile className="border-dashed py-8 text-center">
            <p className="text-[13px] font-medium text-fg">
              {search.trim() ? "No integrations match that search" : "Everything is connected"}
            </p>
            <p className="mt-1 text-[12.5px] text-muted">
              {search.trim()
                ? "Try a provider name, category, or capability."
                : "You have added every integration currently available."}
            </p>
          </Tile>
        )}
      </div>

      {selectedId && selectedItem && (
        <IntegrationConfigDialog
          title={selectedItem.name}
          subtitle={
            selectedItem.installed
              ? "Review the connection, update access, or disconnect it."
              : selectedItem.description
          }
          glyph={<IntegrationGlyph id={selectedItem.id} />}
          status={
            selectedItem.installed ? (
              <Chip
                tone={selectedItem.statusLabel === "Needs reconnect" ? "warning" : "success"}
                dot
              >
                {selectedItem.statusLabel}
              </Chip>
            ) : undefined
          }
          onClose={() => setSelectedId(null)}
        >
          <IntegrationConfiguration id={selectedId} projectId={projectId} />
        </IntegrationConfigDialog>
      )}
    </div>
  );
}

function IntegrationsBentoSkeleton() {
  const sections = [
    ["configured-1", "configured-2"],
    ["available-1", "available-2", "available-3", "available-4"],
  ];

  return (
    <div className="space-y-8" aria-label="Loading integrations">
      {sections.map((cardIds) => (
        <div className="space-y-3" key={cardIds[0]}>
          <SkeletonBlock className="h-4 w-28" />
          <div className="grid gap-3 sm:grid-cols-2">
            {cardIds.map((cardId) => (
              <SkeletonBlock key={cardId} className="h-[142px] rounded-xl" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function IntegrationBentoCard({
  item,
  onSelect,
}: {
  item: IntegrationBentoItem;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="group flex min-h-[142px] flex-col justify-between rounded-xl border border-border bg-surface p-4 text-left transition-colors hover:border-border-strong hover:bg-surface-2/40"
    >
      <span className="flex w-full items-start justify-between gap-3">
        <IntegrationGlyph id={item.id} />
        {item.installed && (
          <Chip tone={item.statusLabel === "Needs reconnect" ? "warning" : "success"} dot>
            {item.statusLabel}
          </Chip>
        )}
      </span>
      <span className="mt-5 block">
        <span className="flex items-center justify-between gap-3">
          <span className="text-[14px] font-medium text-fg">{item.name}</span>
          <span className="text-[11px] text-subtle">{item.category}</span>
        </span>
        <span className="mt-1.5 block text-[12.5px] leading-5 text-muted">{item.description}</span>
        <span className="mt-3 block text-[12px] font-medium text-fg">
          {item.installed ? "Configure" : "+ Add integration"}
        </span>
      </span>
    </button>
  );
}

function IntegrationGlyph({ id }: { id: ProjectIntegrationId }) {
  const className =
    "flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-surface-2 text-fg";
  switch (id) {
    case "github":
      return (
        <span className={className}>
          <GithubIcon size={20} />
        </span>
      );
    case "slack":
      return (
        <span className={className}>
          <SlackIcon size={20} />
        </span>
      );
    case "cloudflare":
      return (
        <span className={className}>
          <CloudflareIcon size={20} />
        </span>
      );
    case "vercel":
      return (
        <span className={className}>
          <VercelIcon size={20} />
        </span>
      );
    case "railway":
      return (
        <span className={className}>
          <RailwayIcon size={20} />
        </span>
      );
    case "render":
      return (
        <span className={className}>
          <RenderIcon size={20} />
        </span>
      );
    case "gcp":
      return (
        <span className={className}>
          <GcpIcon size={20} />
        </span>
      );
    case "aws":
      return (
        <span className={className}>
          <AwsIcon size={20} />
        </span>
      );
    case "porter":
      return <span className={`${className} text-[15px] font-semibold`}>P</span>;
    case "linear":
      return <span className={`${className} text-[15px] font-semibold`}>L</span>;
    case "notion":
      return <span className={`${className} text-[15px] font-semibold`}>N</span>;
  }
}

function IntegrationConfiguration({
  id,
  projectId,
}: {
  id: ProjectIntegrationId;
  projectId: string | undefined;
}) {
  switch (id) {
    case "github":
      return <GithubCard />;
    case "slack":
      return <SlackCard projectId={projectId} />;
    case "linear":
      return <LinearCard />;
    case "notion":
      return <NotionCard />;
    case "cloudflare":
      return <CloudflareCard projectId={projectId} />;
    case "vercel":
      return <VercelCard projectId={projectId} />;
    case "railway":
      return <RailwayCard projectId={projectId} />;
    case "render":
      return <RenderCard projectId={projectId} />;
    case "gcp":
      return <GcpCard projectId={projectId} />;
    case "aws":
      return <AwsCard projectId={projectId} />;
    case "porter":
      return <PorterIntegrationSetup projectId={projectId} />;
  }
}

function GithubCard() {
  const [params] = useSearchParams();
  const install = useGithubInstallation();
  const start = useStartGithubInstall();
  const startAccess = useStartGithubAccessLogin();
  const startAuthor = useStartGithubAuthorLogin();
  const resetAuthor = useResetGithubCommitAuthor();
  const updateRepoAccess = useUpdateGithubRepoAccess();

  const installed = install.data?.installed === true;
  const installations = install.data?.installed ? install.data.installations : [];
  const accounts = installations.length;
  const totalRepos = installations.reduce(
    (sum, installation) => sum + installation.repos.length,
    0,
  );
  const enabledRepos = installations.reduce(
    (sum, installation) =>
      sum + (installation.enabled ? installation.repos.filter((repo) => repo.enabled).length : 0),
    0,
  );
  const commitAuthor = install.data?.installed ? install.data.commitAuthor : null;
  const needsInstall = params.get("github_author") === "no_install";

  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted">
        Required for opening pull requests. Connect GitHub to find existing app installs or add repo
        access.
      </p>
      <div className="flex items-center gap-2">
        {installed ? (
          <Chip tone="success" dot>
            Connected · {accounts} {accounts === 1 ? "account" : "accounts"} · {enabledRepos}/
            {totalRepos} repos enabled
          </Chip>
        ) : (
          <Chip tone="muted" dot>
            Not connected
          </Chip>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Btn
          size="sm"
          variant={installed ? "secondary" : "primary"}
          loading={startAccess.isPending}
          onClick={async () => {
            const { url } = await startAccess.mutateAsync();
            window.location.href = url;
          }}
        >
          {installed ? "Refresh access" : "Connect GitHub"}
        </Btn>
        <Btn
          size="sm"
          variant={needsInstall ? "primary" : "secondary"}
          loading={start.isPending}
          onClick={async () => {
            const { url } = await start.mutateAsync();
            window.location.href = url;
          }}
        >
          {installed ? "Add repositories" : "Install GitHub App"}
        </Btn>
      </div>
      {installed && (
        <div className="space-y-2 pt-2">
          <FieldLabel>Installed accounts</FieldLabel>
          <div className="space-y-2">
            {installations.map((installation) => (
              <div
                key={installation.installationId}
                className="space-y-2 border border-border px-2.5 py-2"
              >
                <div className="flex min-w-0 items-center justify-between gap-3">
                  <label className="flex min-w-0 items-center gap-2">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 accent-accent"
                      checked={installation.enabled}
                      disabled={updateRepoAccess.isPending}
                      onChange={(event) =>
                        updateRepoAccess.mutate({
                          installationId: installation.installationId,
                          enabled: event.target.checked,
                        })
                      }
                    />
                    <div className="min-w-0">
                      <div className="truncate text-[13px] text-fg">
                        {installation.accountLogin ?? `Installation ${installation.installationId}`}
                      </div>
                      <div className="font-sans text-[11px] text-muted">
                        {installation.enabled
                          ? installation.repos.filter((repo) => repo.enabled).length
                          : 0}
                        /{installation.repos.length} repos enabled
                      </div>
                    </div>
                  </label>
                  <Btn
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      window.location.href = installation.manageUrl;
                    }}
                  >
                    Manage
                  </Btn>
                </div>
                <label className="flex items-start gap-2 border-t border-border pt-2">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-3.5 w-3.5 accent-accent"
                    checked={installation.observabilityReviewEnabled}
                    disabled={!installation.enabled || updateRepoAccess.isPending}
                    onChange={(event) =>
                      updateRepoAccess.mutate({
                        installationId: installation.installationId,
                        observabilityReviewEnabled: event.target.checked,
                      })
                    }
                  />
                  <span className="min-w-0">
                    <span className="block text-[12px] text-fg">Review PR observability</span>
                    <span className="block font-sans text-[11px] leading-relaxed text-muted">
                      Check new PR commits for actionable logging, tracing, and metrics gaps.
                    </span>
                  </span>
                </label>
                {installation.repos.length > 0 && (
                  <div className="max-h-48 space-y-1 overflow-y-auto border-t border-border pt-2">
                    {installation.repos.map((repo) => (
                      <label
                        key={repo.id}
                        className={`flex min-w-0 items-center justify-between gap-2 px-1 py-1 ${
                          installation.enabled ? "" : "opacity-50"
                        }`}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <input
                            type="checkbox"
                            className="h-3.5 w-3.5 accent-accent"
                            checked={repo.enabled}
                            disabled={!installation.enabled || updateRepoAccess.isPending}
                            onChange={(event) =>
                              updateRepoAccess.mutate({
                                installationId: installation.installationId,
                                repoId: repo.id,
                                repoEnabled: event.target.checked,
                              })
                            }
                          />
                          <span className="truncate font-sans text-[11px] text-fg">
                            {repo.fullName}
                          </span>
                        </span>
                        <Chip tone={repo.private ? "muted" : "neutral"}>
                          {repo.private ? "private" : "public"}
                        </Chip>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
          <FieldLabel>Commit author</FieldLabel>
          <div className="flex min-w-0 items-center gap-2">
            {commitAuthor?.avatarUrl && (
              <img src={commitAuthor.avatarUrl} alt="" className="h-6 w-6 flex-none rounded-sm" />
            )}
            {!commitAuthor?.avatarUrl && (
              <div className="flex h-6 w-6 flex-none items-center justify-center rounded-sm border border-border font-sans text-[10px] text-muted">
                SL
              </div>
            )}
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <div className="truncate text-[13px] text-fg">
                  {commitAuthor?.name ?? "Superlog app"}
                </div>
                <Chip tone={commitAuthor?.source === "github_user" ? "accent" : "muted"}>
                  {commitAuthor?.source === "github_user" ? "installer" : "default"}
                </Chip>
              </div>
              <div className="truncate font-sans text-[11px] text-muted">
                {commitAuthor?.email ?? "bot@superlog.sh"}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Btn
              size="sm"
              variant="secondary"
              loading={startAuthor.isPending}
              onClick={async () => {
                const { url } = await startAuthor.mutateAsync();
                window.location.href = url;
              }}
            >
              {commitAuthor?.source === "github_user"
                ? "Change app installer"
                : "Use app installer"}
            </Btn>
            {commitAuthor?.source === "github_user" && (
              <Btn
                size="sm"
                variant="ghost"
                loading={resetAuthor.isPending}
                onClick={() => resetAuthor.mutate()}
              >
                Use Superlog app
              </Btn>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SlackCard({ projectId }: { projectId: string | undefined }) {
  const install = useSlackInstallation(projectId, !!projectId);
  const start = useStartSlackInstall(projectId);
  const uninstall = useUninstallSlack(projectId);

  const installed = install.data?.installed === true;

  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted">
        Posts incident threads and routes the agent's questions back to humans. Pick the channel (or
        disable posting) per project below.
      </p>
      <div>
        {installed && install.data?.installed ? (
          <Chip tone="success" dot>
            {install.data.teamName ?? "Workspace"}
          </Chip>
        ) : (
          <Chip tone="muted" dot>
            Not connected
          </Chip>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Btn
          size="sm"
          variant={installed ? "secondary" : "primary"}
          disabled={!projectId}
          loading={start.isPending}
          onClick={async () => {
            const { url } = await start.mutateAsync();
            window.location.href = url;
          }}
        >
          {installed ? "Reinstall" : "Connect Slack"}
        </Btn>
        {installed && (
          <Btn
            size="sm"
            variant="danger"
            disabled={!projectId}
            loading={uninstall.isPending}
            onClick={() => uninstall.mutate()}
          >
            Disconnect
          </Btn>
        )}
      </div>
    </div>
  );
}

function CloudflareCard({ projectId }: { projectId: string | undefined }) {
  const install = useCloudflareInstallation(projectId);
  const start = useStartCloudflareInstall(projectId);
  const uninstall = useUninstallCloudflare(projectId);

  const installed = install.data?.installed === true;

  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted">
        Connect your Cloudflare account and we'll set up Workers Observability destinations that
        stream your Workers traces, logs, and metrics into this project automatically.
      </p>
      <div>
        {installed && install.data?.installed ? (
          <Chip tone="success" dot>
            {install.data.accountName ?? "Cloudflare account"}
          </Chip>
        ) : (
          <Chip tone="muted" dot>
            Not connected
          </Chip>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Btn
          size="sm"
          variant={installed ? "secondary" : "primary"}
          loading={start.isPending}
          disabled={!projectId || start.isPending}
          onClick={async () => {
            const { url } = await start.mutateAsync();
            window.location.href = url;
          }}
        >
          {installed ? "Reconnect" : "Connect Cloudflare"}
        </Btn>
        {installed && (
          <Btn
            size="sm"
            variant="danger"
            loading={uninstall.isPending}
            disabled={!projectId || uninstall.isPending}
            onClick={() => uninstall.mutate()}
          >
            Disconnect
          </Btn>
        )}
      </div>
      {installed && install.data?.installed && (
        <CloudflareWorkers
          projectId={projectId}
          accountId={install.data.accountId}
          autoWire={install.data.autoWire}
        />
      )}
    </div>
  );
}

// The account's Workers, each with its current wiring state. A worker only
// streams to us when its observability config lists our destination — so a
// worker that was recreated/renamed shows up here as "Not wired" and can be
// re-wired with one click (or all at once).
function CloudflareWorkers({
  projectId,
  accountId,
  autoWire,
}: {
  projectId: string | undefined;
  accountId: string;
  autoWire: boolean;
}) {
  const workers = useCloudflareWorkers(projectId, accountId, true);
  const wire = useWireCloudflareWorker(projectId);
  const unwire = useUnwireCloudflareWorker(projectId);
  const wireAll = useWireAllCloudflareWorkers(projectId);
  const setAutoWire = useSetCloudflareAutoWire(projectId);
  const [busy, setBusy] = useState<string | null>(null);

  const list = workers.data?.workers ?? [];
  const anyUnwired = list.some((w) => !w.wired);
  // Any in-flight wiring change. Disable every wiring control while one is
  // pending so overlapping PATCHes (a row click during "Wire all", or vice
  // versa) can't race to a nondeterministic final state.
  const anyWiringPending =
    wire.isPending || unwire.isPending || wireAll.isPending || setAutoWire.isPending;

  return (
    <div className="space-y-3">
      {/* Auto-wire: when on, a periodic reconcile keeps every Worker wired —
          including ones created/recreated after connect — so the list is
          status-only. When off, wiring is manual via the per-row buttons. */}
      <div className="flex items-start justify-between gap-3 rounded-md border border-border bg-surface-2 px-3 py-2.5">
        <div className="min-w-0">
          <div className="text-[13px] font-medium">Auto-wire all Workers</div>
          <p className="mt-0.5 text-[12px] leading-relaxed text-muted">
            Keep every Worker connected automatically, including new or recreated ones. Turn off to
            wire Workers manually.
          </p>
        </div>
        <Toggle
          checked={autoWire}
          disabled={anyWiringPending}
          onChange={(v) => setAutoWire.mutate(v)}
        />
      </div>

      {workers.isLoading ? (
        <p className="text-[13px] text-muted">Loading workers…</p>
      ) : workers.isError ? (
        <p className="text-[13px] text-danger">
          Couldn't load workers — the Cloudflare connection may need reconnecting.
        </p>
      ) : list.length === 0 ? (
        <p className="text-[13px] text-muted">No Workers found in this account.</p>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-medium">Workers</span>
            {!autoWire && (
              <Btn
                size="sm"
                variant="secondary"
                loading={wireAll.isPending}
                disabled={!anyUnwired || anyWiringPending}
                onClick={() => wireAll.mutate()}
              >
                Wire all
              </Btn>
            )}
          </div>
          <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
            {list.map((w) => {
              const pending = busy === w.name && (wire.isPending || unwire.isPending);
              return (
                <li key={w.name} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="min-w-0 truncate text-[13px]">{w.name}</span>
                  <div className="flex flex-shrink-0 items-center gap-2">
                    <Chip tone={w.wired ? "success" : "muted"} dot>
                      {w.wired ? "Streaming" : "Not wired"}
                    </Chip>
                    {!autoWire && (
                      <Btn
                        size="sm"
                        variant={w.wired ? "secondary" : "primary"}
                        loading={pending}
                        disabled={anyWiringPending}
                        onClick={() => {
                          setBusy(w.name);
                          (w.wired ? unwire : wire).mutate(w.name, {
                            onSettled: () => setBusy(null),
                          });
                        }}
                      >
                        {w.wired ? "Unwire" : "Wire"}
                      </Btn>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function VercelCard({ projectId }: { projectId: string | undefined }) {
  const install = useVercelInstallation(projectId);
  const start = useStartVercelInstall(projectId);
  const uninstall = useUninstallVercel(projectId);

  const installed = install.data?.installed === true;

  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted">
        Install the Superlog integration on your Vercel team and we'll set up trace and log drains
        that stream your deployments' telemetry into this project automatically.
      </p>
      <div className="flex items-center gap-2 text-[12.5px]">
        <span className="text-[#8C98F0]">
          <InfoIcon size={13} />
        </span>
        <span className="text-fg">{VERCEL_PLAN_REQUIREMENT}</span>
      </div>
      <div>
        {installed && install.data?.installed ? (
          <Chip tone="success" dot>
            {install.data.teamName ?? "Vercel team"}
          </Chip>
        ) : (
          <Chip tone="muted" dot>
            Not connected
          </Chip>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Btn
          size="sm"
          variant={installed ? "secondary" : "primary"}
          loading={start.isPending}
          disabled={!projectId || start.isPending}
          onClick={async () => {
            const { url } = await start.mutateAsync();
            window.location.href = url;
          }}
        >
          {installed ? "Reconnect" : "Connect Vercel"}
        </Btn>
        {installed && (
          <Btn
            size="sm"
            variant="danger"
            loading={uninstall.isPending}
            disabled={!projectId || uninstall.isPending}
            onClick={() => uninstall.mutate()}
          >
            Disconnect
          </Btn>
        )}
      </div>
    </div>
  );
}

function RailwayCard({ projectId }: { projectId: string | undefined }) {
  const install = useRailwayInstallation(projectId);
  const start = useStartRailwayInstall(projectId);
  const uninstall = useUninstallRailway(projectId);

  const installed = install.data?.installed === true;
  const grantedCount = install.data?.installed ? install.data.grantedProjects.length : 0;

  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted">
        Authorize Railway and pick the projects to share — we pull your services' logs and infra
        metrics from Railway's API into this project automatically. Read-only, revocable any time.
      </p>
      <div>
        {installed ? (
          <Chip tone="success" dot>
            {grantedCount === 1 ? "1 Railway project" : `${grantedCount} Railway projects`}
          </Chip>
        ) : (
          <Chip tone="muted" dot>
            Not connected
          </Chip>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Btn
          size="sm"
          variant={installed ? "secondary" : "primary"}
          loading={start.isPending}
          disabled={!projectId || start.isPending}
          onClick={async () => {
            const { url } = await start.mutateAsync();
            window.location.href = url;
          }}
        >
          {installed ? "Reconnect" : "Connect Railway"}
        </Btn>
        {installed && (
          <Btn
            size="sm"
            variant="danger"
            loading={uninstall.isPending}
            disabled={!projectId || uninstall.isPending}
            onClick={() => uninstall.mutate()}
          >
            Disconnect
          </Btn>
        )}
      </div>
    </div>
  );
}

// Render connect is an API-key paste (no OAuth redirect), so the card embeds
// the same two-step form as the onboarding flow in a compact shape: validate
// the key → pick a workspace → connect.
function RenderCard({ projectId }: { projectId: string | undefined }) {
  const install = useRenderInstallation(projectId);
  const validate = useRenderOwners(projectId);
  const connect = useConnectRender(projectId);
  const uninstall = useUninstallRender(projectId);
  // Self-hosted deployments without AGENT_SECRETS_KEY can't store the pasted
  // key — don't offer a connect that would only ever 503.
  const capabilities = useSystemCapabilities();
  const unavailable = capabilities.data ? !capabilities.data.renderConnect : false;

  const [apiKey, setApiKey] = useState("");
  const [owners, setOwners] = useState<RenderOwner[] | null>(null);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const installed = install.data?.installed === true;
  const serviceCount = install.data?.installed
    ? install.data.services.filter((s) => !s.suspended).length
    : 0;

  const reset = () => {
    setApiKey("");
    setOwners(null);
    setOwnerId(null);
    setConnecting(false);
    validate.reset();
    connect.reset();
  };

  const error = connect.error
    ? renderErrorMessage(connect.error)
    : validate.error
      ? renderErrorMessage(validate.error)
      : null;

  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted">
        Paste a Render API key and pick the workspace to share — we set up Render's log and metrics
        streams to push your services' telemetry into this project (with API polling as fallback).
        The key is stored encrypted; revoke it in Render at any time.
      </p>
      <div>
        {installed ? (
          <Chip tone="success" dot>
            {install.data?.installed && install.data.ownerName
              ? `${install.data.ownerName} — ${serviceCount === 1 ? "1 service" : `${serviceCount} services`}`
              : `${serviceCount} services`}
          </Chip>
        ) : (
          <Chip tone="muted" dot>
            Not connected
          </Chip>
        )}
      </div>
      {connecting && !owners && (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (validate.isPending || !apiKey.trim()) return;
            validate.mutate(apiKey.trim(), {
              onSuccess: ({ owners }) => {
                setOwners(owners);
                setOwnerId(owners.length === 1 ? (owners[0]?.id ?? null) : null);
              },
            });
          }}
        >
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="rnd_…"
            autoComplete="off"
            spellCheck={false}
            className="h-[32px] min-w-0 flex-1 rounded-[8px] border border-border bg-surface-2 px-2.5 font-sans text-[12.5px] text-fg placeholder:text-subtle focus:outline-none"
          />
          <Btn
            size="sm"
            variant="primary"
            type="submit"
            loading={validate.isPending}
            disabled={!apiKey.trim()}
          >
            Validate
          </Btn>
          <Btn size="sm" variant="secondary" onClick={reset}>
            Cancel
          </Btn>
        </form>
      )}
      {connecting && owners && (
        <div className="flex items-center gap-2">
          <select
            value={ownerId ?? ""}
            onChange={(e) => setOwnerId(e.target.value || null)}
            className="h-[32px] min-w-0 flex-1 rounded-[8px] border border-border bg-surface-2 px-2 text-[12.5px] text-fg focus:outline-none"
          >
            <option value="">Pick a workspace…</option>
            {owners.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
                {o.type === "team" ? " (team)" : ""}
              </option>
            ))}
          </select>
          <Btn
            size="sm"
            variant="primary"
            loading={connect.isPending}
            disabled={!ownerId}
            onClick={() => {
              if (!ownerId) return;
              connect.mutate({ apiKey: apiKey.trim(), ownerId }, { onSuccess: () => reset() });
            }}
          >
            Connect
          </Btn>
          <Btn size="sm" variant="secondary" onClick={reset}>
            Cancel
          </Btn>
        </div>
      )}
      {error && <p className="m-0 text-[12.5px] text-danger">{error}</p>}
      {unavailable && (
        <p className="m-0 text-[12.5px] text-muted">
          Render connect isn't configured in this environment — the server needs an integration
          secrets key (AGENT_SECRETS_KEY) to store pasted API keys encrypted.
        </p>
      )}
      {!connecting && (
        <div className="flex items-center gap-2">
          <Btn
            size="sm"
            variant={installed ? "secondary" : "primary"}
            disabled={!projectId || unavailable}
            onClick={() => setConnecting(true)}
          >
            {installed ? "Reconnect" : "Connect Render"}
          </Btn>
          {installed && (
            <Btn
              size="sm"
              variant="danger"
              loading={uninstall.isPending}
              disabled={!projectId || uninstall.isPending}
              onClick={() => uninstall.mutate()}
            >
              Disconnect
            </Btn>
          )}
        </div>
      )}
    </div>
  );
}

function SlackRoutingCard({ projectId }: { projectId: string | undefined }) {
  const install = useSlackInstallation(projectId, !!projectId);
  const installed = install.data?.installed === true;
  const route = useSlackRoute(projectId);
  const channels = useSlackChannels(installed && !!projectId, projectId);
  const setRoute = useSetSlackRoute(projectId ?? "");
  const deleteRoute = useDeleteSlackRoute(projectId ?? "");

  const routeData = route.data;
  const configured = routeData?.configured === true;
  const currentChannelId = routeData?.configured ? routeData.channelId : "";
  const currentChannelName = routeData?.configured ? routeData.channelName : null;

  const [pendingChannelId, setPendingChannelId] = useState<string>("");
  useEffect(() => {
    setPendingChannelId(currentChannelId);
  }, [currentChannelId]);

  const channelList = channels.data?.channels ?? [];
  const dirty = pendingChannelId !== "" && pendingChannelId !== currentChannelId;

  if (!installed) {
    return (
      <Tile>
        <p className="text-[13px] text-muted">
          Connect Slack in the Integrations section above to pick a channel for this project.
        </p>
      </Tile>
    );
  }

  return (
    <SettingsCard>
      <SettingsRow
        title="Incident threads"
        description={
          configured
            ? `Posting to #${currentChannelName ?? currentChannelId}`
            : "Disabled — incidents are not posted to Slack"
        }
        control={
          configured ? (
            <Btn
              size="sm"
              variant="danger"
              disabled={!projectId || deleteRoute.isPending}
              loading={deleteRoute.isPending}
              onClick={() => deleteRoute.mutate()}
            >
              Disable
            </Btn>
          ) : undefined
        }
      />
      <SettingsRow
        title="Channel"
        description={
          channels.isError ? (
            "Couldn't fetch the channel list — try reconnecting Slack."
          ) : (
            <>
              Private channels only appear once the bot is invited — run{" "}
              <code className="rounded-sm bg-surface-2 px-1 py-0.5 text-[11px]">
                /invite @Superlog
              </code>{" "}
              there first
            </>
          )
        }
        control={
          <>
            <div className="w-60">
              <Dropdown
                value={pendingChannelId}
                onChange={setPendingChannelId}
                disabled={!projectId || channels.isLoading || channels.isError}
                placeholder={
                  channels.isLoading
                    ? "Loading channels…"
                    : channels.isError
                      ? "Failed to load channels"
                      : "Select a channel…"
                }
                emptyLabel="No channels found"
                options={channelList.map((ch) => ({
                  value: ch.id,
                  searchText: `${ch.isPrivate ? "🔒 " : "#"}${ch.name}`,
                  label: (
                    <span className="flex items-center gap-1.5">
                      <span className="text-subtle">{ch.isPrivate ? "🔒" : "#"}</span>
                      <span>{ch.name}</span>
                    </span>
                  ),
                }))}
              />
            </div>
            <Btn
              size="sm"
              variant="primary"
              disabled={!projectId || !dirty || setRoute.isPending}
              loading={setRoute.isPending}
              onClick={async () => {
                const ch = channelList.find((c) => c.id === pendingChannelId);
                if (!ch) return;
                await setRoute.mutateAsync(ch);
              }}
            >
              {configured ? "Update" : "Enable"}
            </Btn>
          </>
        }
      />
    </SettingsCard>
  );
}

function WeeklyDigestCard({ projectId }: { projectId: string | undefined }) {
  const install = useSlackInstallation(projectId, !!projectId);
  const installed = install.data?.installed === true;
  const digest = useProjectDigest(projectId);
  const channels = useSlackChannels(installed && !!projectId, projectId);
  const save = useSaveProjectDigest(projectId);
  const runNow = useRunProjectDigestNow(projectId);

  const enabled = digest.data?.enabled ?? false;
  const channelId = digest.data?.channelId ?? "";
  const channelName = digest.data?.channelName ?? null;
  const lastRunAt = digest.data?.lastRunAt;
  const runRequestedAt = digest.data?.runRequestedAt;
  const channelList = channels.data?.channels ?? [];

  if (!installed) {
    return (
      <Tile>
        <p className="text-[13px] text-muted">
          Connect Slack in the Integrations section above to enable the weekly digest.
        </p>
      </Tile>
    );
  }

  const lastRunLabel = lastRunAt
    ? `Last sent ${new Date(lastRunAt).toLocaleString()}`
    : "Never sent";

  return (
    <SettingsCard>
      <SettingsRow
        title="Post a weekly project recap to Slack"
        description={weeklyDigestStatusDescription({
          enabled,
          channelId,
          channelName,
          lastRunLabel,
        })}
        control={
          <Toggle
            checked={enabled}
            disabled={weeklyDigestToggleDisabled({ enabled, channelId, saving: save.isPending })}
            onChange={(v) => save.mutate({ enabled: v })}
          />
        }
      />
      <SettingsRow
        title="Channel"
        description="Picking a channel turns the recap on. Use a different channel from incident threads if it's noisy — invite the bot to private channels"
        control={
          <div className="w-60">
            <Dropdown
              value={channelId}
              disabled={channels.isLoading || channels.isError || save.isPending}
              onChange={(next) => {
                const selection = weeklyDigestChannelSelection(next, channelList);
                if (selection) save.mutate(selection);
              }}
              placeholder={
                channels.isLoading
                  ? "Loading channels…"
                  : channels.isError
                    ? "Failed to load channels"
                    : "Select a channel…"
              }
              emptyLabel="No channels found"
              options={channelList.map((ch) => ({
                value: ch.id,
                searchText: `${ch.isPrivate ? "🔒 " : "#"}${ch.name}`,
                label: (
                  <span className="flex items-center gap-1.5">
                    <span className="text-subtle">{ch.isPrivate ? "🔒" : "#"}</span>
                    <span>{ch.name}</span>
                  </span>
                ),
              }))}
            />
          </div>
        }
      />
      <SettingsRow
        title="Send a test digest"
        description={
          runRequestedAt
            ? "Queued for delivery — it should arrive in Slack within a few seconds"
            : "Immediately rank this project's open bug-fix PRs and post the top 3"
        }
        control={
          <Btn
            size="sm"
            variant="secondary"
            disabled={!projectId || !channelId || runNow.isPending || !!runRequestedAt}
            loading={runNow.isPending || !!runRequestedAt}
            onClick={() => runNow.mutate()}
          >
            {runRequestedAt ? "Sending…" : "Send test now"}
          </Btn>
        }
      />
      {runNow.isError && (
        <p className="m-0 px-4 pb-3 text-[12.5px] text-danger">
          {runNow.error instanceof Error ? runNow.error.message : "Couldn't queue the test digest"}
        </p>
      )}
    </SettingsCard>
  );
}

function LinearCard() {
  const install = useLinearInstallation();
  const start = useStartLinearInstall();
  const uninstall = useUninstallLinear();

  const linearInstall = install.data?.installed === true ? install.data : null;
  const installed = linearInstall !== null;
  const needsReauth = linearInstall?.needsReauth === true;

  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted">
        Lets the agent file and update tickets while it investigates. Tickets are tagged with the
        incident id so subsequent runs find and update the same issue.
      </p>
      <div>
        {linearInstall ? (
          <Chip tone={needsReauth ? "warning" : "success"} dot>
            {needsReauth
              ? `${linearInstall.workspaceName ?? "Workspace"} needs reconnect`
              : (linearInstall.workspaceName ?? "Workspace")}
          </Chip>
        ) : (
          <Chip tone="muted" dot>
            Not connected
          </Chip>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Btn
          size="sm"
          variant={installed ? "secondary" : "primary"}
          loading={start.isPending}
          onClick={async () => {
            const { url } = await start.mutateAsync();
            window.location.href = url;
          }}
        >
          {needsReauth ? "Reconnect Linear" : installed ? "Reconnect" : "Connect Linear"}
        </Btn>
        {installed && (
          <Btn
            size="sm"
            variant="danger"
            loading={uninstall.isPending}
            onClick={() => uninstall.mutate()}
          >
            Disconnect
          </Btn>
        )}
      </div>
    </div>
  );
}

function NotionCard() {
  const install = useNotionInstallation();
  const start = useStartNotionInstall();
  const uninstall = useUninstallNotion();

  const notionInstall = install.data?.installed === true ? install.data : null;
  const installed = notionInstall !== null;
  const needsReauth = notionInstall?.needsReauth === true;

  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted">
        Lets the agent read pages and databases from your Notion workspace while it investigates —
        runbooks, architecture notes, and on-call docs. Only pages you share with the Superlog
        integration are visible.
      </p>
      <div>
        {notionInstall ? (
          <Chip tone={needsReauth ? "warning" : "success"} dot>
            {needsReauth
              ? `${notionInstall.workspaceName ?? "Workspace"} needs reconnect`
              : (notionInstall.workspaceName ?? "Workspace")}
          </Chip>
        ) : (
          <Chip tone="muted" dot>
            Not connected
          </Chip>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Btn
          size="sm"
          variant={installed ? "secondary" : "primary"}
          loading={start.isPending}
          onClick={async () => {
            const { url } = await start.mutateAsync();
            window.location.href = url;
          }}
        >
          {needsReauth ? "Reconnect Notion" : installed ? "Reconnect" : "Connect Notion"}
        </Btn>
        {installed && (
          <Btn
            size="sm"
            variant="danger"
            loading={uninstall.isPending}
            onClick={() => uninstall.mutate()}
          >
            Disconnect
          </Btn>
        )}
      </div>
    </div>
  );
}

function awsStatusChip(c?: CloudConnection) {
  if (!c)
    return (
      <Chip tone="muted" dot>
        Not connected
      </Chip>
    );
  switch (c.status) {
    case "connected":
      return (
        <Chip tone="success" dot>
          Connected · {c.accountId} · {c.region}
        </Chip>
      );
    case "pending":
      return (
        <Chip tone="warning" dot>
          Awaiting stack deploy
        </Chip>
      );
    case "account_mismatch":
      return (
        <Chip tone="danger" dot>
          Account mismatch
        </Chip>
      );
    case "failed":
      return (
        <Chip tone="danger" dot>
          Verification failed
        </Chip>
      );
  }
}

// Commercial AWS regions. Metric streams / Firehose are regional, so the
// connection targets one region (multi-region = multiple connections later).
const AWS_REGION_OPTIONS = AWS_REGIONS.map((r) => ({
  value: r.code,
  label: (
    <span>
      <span className="font-sans">{r.code}</span>
      <span className="text-muted"> · {r.name}</span>
    </span>
  ),
  searchText: `${r.code} ${r.name}`,
}));

type IngestSourceDefinition = {
  source: IngestSource;
  title: string;
  hint: string;
  signals: ReadonlyArray<{ key: IngestSignal; label: string }>;
};

const INGEST_SOURCE_DEFINITIONS = [
  {
    source: "otlp",
    title: "SDK / OTLP",
    hint: "Telemetry sent by your apps' OpenTelemetry exporters.",
    signals: [
      { key: "traces", label: "Traces" },
      { key: "logs", label: "Logs" },
      { key: "metrics", label: "Metrics" },
    ],
  },
  {
    source: "aws",
    title: "AWS CloudWatch",
    hint: "Metric streams and account logs from the connected AWS stack.",
    signals: [
      { key: "logs", label: "Logs" },
      { key: "metrics", label: "Metrics" },
    ],
  },
  {
    source: "gcp",
    title: "Google Cloud",
    hint: "Cloud Logging and bounded Cloud Monitoring metrics from the connected GCP project.",
    signals: [
      { key: "logs", label: "Logs" },
      { key: "metrics", label: "Metrics" },
    ],
  },
  {
    source: "vercel",
    title: "Vercel Drains",
    hint: "Trace and log drains created by the connected Vercel integration.",
    signals: [
      { key: "traces", label: "Traces" },
      { key: "logs", label: "Logs" },
    ],
  },
  {
    source: "railway",
    title: "Railway",
    hint: "Logs and infrastructure metrics from connected Railway projects.",
    signals: [
      { key: "logs", label: "Logs" },
      { key: "metrics", label: "Metrics" },
    ],
  },
  {
    source: "render",
    title: "Render",
    hint: "Logs and infrastructure metrics from the connected Render workspace.",
    signals: [
      { key: "logs", label: "Logs" },
      { key: "metrics", label: "Metrics" },
    ],
  },
] as const satisfies ReadonlyArray<IngestSourceDefinition>;

function IngestSourceRow({
  source,
  title,
  hint,
  signals,
  state,
  disabled,
  onToggle,
}: {
  source: IngestSource;
  title: string;
  hint: string;
  signals: ReadonlyArray<{ key: IngestSignal; label: string }>;
  state: Partial<Record<IngestSignal, boolean>>;
  disabled: boolean;
  onToggle: (signal: IngestSignal, next: boolean) => void;
}) {
  const enabledCount = signals.filter((signal) => state[signal.key] ?? true).length;

  return (
    <DataListRow className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <DataListCell className="flex min-w-0 items-center gap-3">
        <IngestSourceIcon source={source} />
        <span className="min-w-0">
          <span className="flex items-center gap-2">
            <span className="text-[13px] font-medium text-fg">{title}</span>
            <Chip tone={enabledCount === 0 ? "muted" : "success"} dot>
              {enabledCount}/{signals.length} on
            </Chip>
          </span>
          <span className="mt-0.5 block text-[12px] leading-5 text-muted">{hint}</span>
        </span>
      </DataListCell>
      <DataListCell className="flex flex-wrap items-center gap-x-5 gap-y-2 sm:justify-end">
        {signals.map((s) => (
          <span
            key={s.key}
            className="flex min-w-[92px] items-center justify-between gap-3 text-[12.5px]"
          >
            <span className={state[s.key] === false ? "text-muted" : "text-fg"}>{s.label}</span>
            <Toggle
              ariaLabel={`Ingest ${s.label.toLowerCase()} from ${title}`}
              checked={state[s.key] ?? true}
              onChange={(next) => onToggle(s.key, next)}
              disabled={disabled}
            />
          </span>
        ))}
      </DataListCell>
    </DataListRow>
  );
}

function IngestSourceIcon({ source }: { source: IngestSource }) {
  const className =
    "flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface-2 text-fg";

  switch (source) {
    case "otlp":
      return (
        <span className={className}>
          <OtelIcon size={18} />
        </span>
      );
    case "aws":
      return (
        <span className={className}>
          <AwsIcon size={18} />
        </span>
      );
    case "vercel":
      return (
        <span className={className}>
          <VercelIcon size={18} />
        </span>
      );
    case "railway":
      return (
        <span className={className}>
          <RailwayIcon size={18} />
        </span>
      );
    case "render":
      return (
        <span className={className}>
          <RenderIcon size={18} />
        </span>
      );
    case "gcp":
      return (
        <span className={className}>
          <GcpIcon size={18} />
        </span>
      );
  }
}

function IngestSourcesCard({ projectId }: { projectId: string | undefined }) {
  const filters = useIngestFilters(projectId);
  const setFilters = useSetIngestFilters(projectId ?? "");
  const state = filters.data;

  const setSignal = (source: IngestSource, signal: IngestSignal, next: boolean) => {
    if (!state) return;
    setFilters.mutate(updateIngestSignal(state, source, signal, next));
  };

  const totalSignals = INGEST_SOURCE_DEFINITIONS.reduce(
    (total, source) => total + source.signals.length,
    0,
  );
  const enabledSignals = state
    ? INGEST_SOURCE_DEFINITIONS.reduce(
        (total, source) =>
          total +
          source.signals.filter((signal) => isIngestSignalEnabled(state, source.source, signal.key))
            .length,
        0,
      )
    : 0;

  return (
    <div className="space-y-4">
      <Tile className="bg-surface-2/30">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <Label>Edge policy</Label>
            <p className="mt-2 max-w-2xl text-[13px] leading-5 text-muted">
              Disabled signals are acknowledged and dropped before storage, so they never count
              toward retention or billing.
            </p>
          </div>
          <Chip tone="neutral" dot>
            {state ? `${enabledSignals} of ${totalSignals} signals on` : "Loading policy"}
          </Chip>
        </div>
      </Tile>

      {filters.isError ? (
        <Tile>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-[13px] font-medium text-fg">Couldn’t load data controls</p>
              <p className="mt-1 text-[12px] text-muted">
                The current ingest policy is unavailable. No changes have been made.
              </p>
            </div>
            <Btn size="sm" variant="secondary" onClick={() => filters.refetch()}>
              Retry
            </Btn>
          </div>
        </Tile>
      ) : (
        <DataList label="Telemetry source controls">
          <DataListHeader className="grid grid-cols-[minmax(0,1fr)_auto] gap-4">
            <DataListHeaderCell>Source</DataListHeaderCell>
            <DataListHeaderCell className="text-right">Signals ingested</DataListHeaderCell>
          </DataListHeader>
          {!state
            ? INGEST_SOURCE_DEFINITIONS.map((source) => (
                <DataListRow
                  key={source.source}
                  className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                >
                  <DataListCell className="flex items-center gap-3">
                    <SkeletonBlock className="h-9 w-9" />
                    <span className="space-y-2">
                      <SkeletonBlock className="h-3 w-28" />
                      <SkeletonBlock className="h-3 w-52 max-w-full" />
                    </span>
                  </DataListCell>
                  <DataListCell>
                    <SkeletonBlock className="h-5 w-48" />
                  </DataListCell>
                </DataListRow>
              ))
            : INGEST_SOURCE_DEFINITIONS.map((source) => (
                <IngestSourceRow
                  key={source.source}
                  {...source}
                  state={state[source.source]}
                  disabled={setFilters.isPending}
                  onToggle={(signal, next) => setSignal(source.source, signal, next)}
                />
              ))}
        </DataList>
      )}

      <div className="flex items-start gap-2 px-1 text-[12px] leading-5 text-muted">
        <span className="mt-0.5 shrink-0 text-accent">
          <InfoIcon size={13} />
        </span>
        <p>
          Changes apply to new telemetry immediately. Previously stored data is not removed when a
          signal is turned off.
        </p>
      </div>
      {setFilters.isError && (
        <p className="px-1 text-[12px] text-warning">
          The last change couldn’t be saved. Your previous policy is still active.
        </p>
      )}
    </div>
  );
}

function GcpCard({ projectId }: { projectId: string | undefined }) {
  const connection = useGcpConnection(projectId);
  const start = useStartGcpConnect(projectId);
  const capabilities = useSystemCapabilities();
  const row =
    connection.data?.connected !== undefined && "status" in connection.data
      ? connection.data
      : null;
  const configured = capabilities.data?.gcpConnect ?? true;
  const connectAction = gcpConnectAction(row?.status ?? null);

  return (
    <Tile label="Google Cloud">
      <div className="space-y-3">
        <p className="text-[13px] text-muted">
          Connect a GCP project through Google OAuth. We create its Cloud Logging route, then read a
          curated set of Cloud Monitoring metrics with a hard monthly series ceiling. No Terraform
          or service-account key is required.
        </p>
        <div className="rounded-md border border-[rgba(65,209,149,0.25)] bg-[rgba(65,209,149,0.05)] px-3 py-2 text-[12.5px] text-fg">
          Customer incremental GCP cost: <strong>$0</strong>. Superlog owns and pays for Pub/Sub and
          Monitoring API reads. Metric reads stop at{" "}
          {row?.metricsMonthlySeriesLimit.toLocaleString() ?? "100,000,000"} returned series per
          month (at most about $50 at current list price, paid by Superlog). Existing Cloud Logging
          ingestion or retention charges are unchanged.
        </div>
        <div>
          {row?.status === "connected" ? (
            <Chip tone="success" dot>
              {row.gcpProjectId}
            </Chip>
          ) : row ? (
            <Chip tone={row.status === "failed" ? "danger" : "muted"} dot>
              {row.status === "failed" ? "Setup failed" : "Setup in progress"}
            </Chip>
          ) : (
            <Chip tone="muted" dot>
              Not connected
            </Chip>
          )}
        </div>
        {row?.lastError && <p className="text-[12.5px] text-danger">{row.lastError}</p>}
        {!configured && (
          <p className="text-[12.5px] text-muted">
            GCP connect is not configured on this deployment.
          </p>
        )}
        <div className="flex justify-end">
          <Btn
            size="sm"
            variant="primary"
            loading={start.isPending}
            disabled={!projectId || !configured || start.isPending}
            onClick={async () => {
              const { url } = await start.mutateAsync();
              window.location.href = url;
            }}
          >
            {connectAction.buttonLabel}
          </Btn>
        </div>
        {start.error && <p className="text-[12.5px] text-danger">{String(start.error)}</p>}
      </div>
    </Tile>
  );
}

function AwsCard({ projectId }: { projectId: string | undefined }) {
  const connections = useCloudConnections(projectId);
  const create = useCreateCloudConnection(projectId ?? "");
  const verify = useVerifyCloudConnection(projectId ?? "");
  const del = useDeleteCloudConnection(projectId ?? "");

  const [region, setRegion] = useState("us-west-2");
  // The launch URL + external id are only returned once, at create time — keep
  // them in memory to drive the "deploy then paste the ARN" step.
  const [created, setCreated] = useState<{ id: string; launchUrl: string } | null>(null);
  const [roleArn, setRoleArn] = useState("");

  const list = connections.data ?? [];
  const active = list.find((c) => c.status === "connected") ?? list[0];
  // The connection we're mid-setup on: just created, or an existing un-verified row.
  const setupTarget = active && active.status !== "connected" ? active : undefined;

  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted">
        Connect your AWS account to inventory resources and stream CloudWatch metrics. Deploys a
        read-only IAM role you control via CloudFormation — revoke any time.
      </p>

      <div>{awsStatusChip(active)}</div>

      {active?.status === "connected" ? (
        <div className="space-y-3">
          <AwsStackHealthPanel
            projectId={projectId}
            connectionId={active.id}
            region={active.region}
          />
          <Btn
            size="sm"
            variant="danger"
            loading={del.isPending}
            onClick={() => del.mutate(active.id)}
          >
            Disconnect
          </Btn>
        </div>
      ) : setupTarget || created ? (
        <div className="space-y-2">
          {created && (
            <Btn
              size="sm"
              variant="primary"
              onClick={() => window.open(created.launchUrl, "_blank", "noopener")}
            >
              Launch CloudFormation stack
            </Btn>
          )}
          {created && (
            <p className="text-[12px] text-muted">
              After you create the stack it connects automatically — this updates on its own. Or
              paste the Role ARN from the stack's Outputs below.
            </p>
          )}
          <FieldLabel>Role ARN (from the stack's Outputs)</FieldLabel>
          <Input
            value={roleArn}
            onChange={(e) => setRoleArn(e.target.value)}
            placeholder="arn:aws:iam::123456789012:role/SuperlogScrapeRole"
          />
          {setupTarget &&
            (setupTarget.status === "failed" || setupTarget.status === "account_mismatch") && (
              <p className="text-[12px] text-danger">
                {setupTarget.lastError ??
                  "Couldn't assume the role — confirm the stack deployed and the ARN is correct."}
              </p>
            )}
          <div className="flex items-center gap-2">
            <Btn
              size="sm"
              variant="primary"
              loading={verify.isPending}
              disabled={!roleArn.trim()}
              onClick={async () => {
                const id = created?.id ?? setupTarget?.id;
                if (!id) return;
                const res = await verify.mutateAsync({
                  id,
                  scrapeRoleArn: roleArn.trim(),
                });
                if (res.status === "connected") {
                  setCreated(null);
                  setRoleArn("");
                }
              }}
            >
              Verify connection
            </Btn>
            <Btn
              size="sm"
              variant="ghost"
              loading={del.isPending}
              onClick={() => {
                const id = created?.id ?? setupTarget?.id;
                setCreated(null);
                setRoleArn("");
                if (id) del.mutate(id);
              }}
            >
              Cancel
            </Btn>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <FieldLabel>Region</FieldLabel>
          <Dropdown
            value={region}
            onChange={setRegion}
            options={AWS_REGION_OPTIONS}
            placeholder="Select a region…"
          />
          <Btn
            size="sm"
            variant="primary"
            loading={create.isPending}
            disabled={!projectId || !region.trim()}
            onClick={async () => {
              const res = await create.mutateAsync({ region: region.trim() });
              setCreated({ id: res.id, launchUrl: res.launchUrl });
            }}
          >
            Connect AWS
          </Btn>
        </div>
      )}
    </div>
  );
}

// Dot color per reconciliation state.
const STACK_STATE_DOT: Record<StackComponent["state"], string> = {
  working: "bg-success",
  pending: "bg-warning",
  broken: "bg-danger",
  missing: "bg-subtle",
};

// Reconciliation checklist for a connected AWS account: each piece of the stack
// (connection / metric streaming / log streaming) shown as in-place, missing,
// working, or broken, with a per-row action to drive it to a working state.
// State comes from the connection's verify status + the stream keys' delivery
// signal; "Set up"/"Re-launch" opens the (idempotent) CloudFormation stack.
function AwsStackHealthPanel({
  projectId,
  connectionId,
  region,
}: {
  projectId: string | undefined;
  connectionId: string;
  region: string;
}) {
  const health = useCloudStackHealth(projectId, connectionId, true);
  const setup = useSetupCloudStream(projectId ?? "");

  const components = health.data?.components ?? [];
  const working = components.filter((c) => c.state === "working").length;

  // Streams carry a last-received time we append; the connection row doesn't.
  const detailLine = (c: StackComponent) =>
    c.lastReceivedAt ? `${c.detail} · last received ${formatRelative(c.lastReceivedAt)}` : c.detail;

  return (
    <div className="space-y-2 rounded-md border border-subtle/40 p-3">
      <div className="flex items-center justify-between">
        <div className="text-[12px] font-medium">Integration stack · {region}</div>
        {components.length > 0 && (
          <div className="text-[11px] text-subtle">
            {working}/{components.length} working
          </div>
        )}
      </div>

      {components.map((c) => {
        const isStream = c.key === "metrics" || c.key === "logs";
        const action = isStream
          ? c.state === "missing"
            ? { label: "Set up", variant: "primary" as const }
            : { label: "Re-launch", variant: "ghost" as const }
          : null;
        return (
          <div key={c.key} className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-[13px]">
                <span
                  className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${STACK_STATE_DOT[c.state]}`}
                />
                {c.label}
              </div>
              <div className={`text-[12px] ${c.state === "broken" ? "text-danger" : "text-muted"}`}>
                {detailLine(c)}
              </div>
            </div>
            {action && (
              <Btn
                size="sm"
                variant={action.variant}
                loading={setup.isPending && setup.variables?.kind === c.key}
                onClick={async () => {
                  const res = await setup.mutateAsync({
                    connectionId,
                    kind: c.key as "metrics" | "logs",
                  });
                  window.open(res.launchUrl, "_blank", "noopener");
                }}
              >
                {action.label}
              </Btn>
            )}
          </div>
        );
      })}

      <p className="text-[11px] text-subtle">
        Streaming runs in your AWS account (CloudWatch → Firehose); costs are billed to you.
        “Re-launch” re-opens the same CloudFormation stack — safe to re-run — to repair it, change
        namespaces, or tear it down.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent flowchart
// ---------------------------------------------------------------------------

const ORG_GUIDANCE_MAX_LEN = 8000;

function OrgGuidanceCard() {
  const settings = useOrgAgentSettings();
  const save = useSaveOrgAgentSettings();
  const value = settings.data?.customInstructions ?? "";
  const [draft, setDraft] = useState(value);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!loaded && settings.data) {
      setDraft(settings.data.customInstructions);
      setLoaded(true);
    }
  }, [loaded, settings.data]);

  const dirty = loaded && draft !== value;
  const disabled = settings.isLoading || save.isPending;

  return (
    <Tile>
      <div className="space-y-2">
        <FieldLabel>Org-wide agent guidance</FieldLabel>
        <textarea
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value.slice(0, ORG_GUIDANCE_MAX_LEN))}
          rows={5}
          placeholder="e.g. Always link incidents to the on-call runbook before filing a ticket. Prefer reverts over forward fixes for prod regressions."
          className="w-full rounded-lg border border-border bg-surface-2 p-3 font-sans text-[12.5px] text-fg placeholder:text-subtle focus:border-border-strong focus:outline-none disabled:opacity-60"
        />
        <div className="flex items-center justify-between text-[12px] text-muted">
          <span>Prepended to every agent run prompt across all projects in this org.</span>
          <span className="font-sans tabular-nums">
            {draft.length} / {ORG_GUIDANCE_MAX_LEN}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Btn
            size="sm"
            variant="primary"
            disabled={!dirty || disabled}
            onClick={() => save.mutate({ customInstructions: draft })}
          >
            Save guidance
          </Btn>
          {dirty && (
            <Btn size="sm" variant="ghost" onClick={() => setDraft(value)}>
              Discard
            </Btn>
          )}
        </div>
      </div>
    </Tile>
  );
}

function AgentFlowchart({ projectId }: { projectId: string | undefined }) {
  const settings = useAgentSettings(projectId);
  const save = useSaveAgentSettings(projectId);
  const linear = useLinearInstallation();
  const github = useGithubInstallation();

  const linearConnected = linear.data?.installed === true && !linear.data.needsReauth;
  const linearNeedsReauth = linear.data?.installed === true && linear.data.needsReauth;
  const githubConnected = github.data?.installed === true;
  const branches = useGithubBranches(projectId, githubConnected);

  const data: AgentSettings = settings.data ?? {
    customInstructions: "",
    agentRunEnabled: true,
    linearTicketPolicy: "on_ready_to_pr",
    linearTicketInstructions: [],
    prPolicy: "on_ready_to_pr",
    approvalPromptsEnabled: true,
    createLinearTicketOnResolve: false,
    autoResolveStaleIncidentsEnabled: true,
    prBaseBranch: null,
    autoMergeFixPrs: "never",
    autoMergeMethod: "squash",
    issueFilterConfig: EMPTY_ISSUE_FILTER_CONFIG,
  };

  const investigateOn = data.agentRunEnabled;
  const downstreamEligible = investigateOn;

  const patch = (p: Partial<AgentSettings>) => save.mutate(p);

  return (
    <Tile padded={false}>
      <div className="p-5">
        <FlowNode step={1} title="Incident open" spineActive headerOnly />

        <FlowConnector active={investigateOn} />

        <FlowNode
          step={2}
          title="Investigate"
          headerSlot={
            <Toggle
              checked={investigateOn}
              disabled={save.isPending}
              onChange={(v) => patch({ agentRunEnabled: v })}
            />
          }
          spineActive={investigateOn}
          accent
          off={!investigateOn}
        >
          <div className="space-y-4">
            <p className="text-[12.5px] text-muted">
              The agent loads the incident, picks the most relevant repo, and reproduces or
              otherwise validates the bug. Turning this off disables every downstream step — no
              Linear tickets, no PRs.
            </p>
            <InstructionsField
              value={data.customInstructions}
              disabled={!investigateOn || save.isPending}
              onSave={(v) => patch({ customInstructions: v })}
            />
            <ToolsSection disabled={!investigateOn} />
            <div className="flex items-start justify-between gap-4 rounded-md border border-border px-3 py-3">
              <div>
                <div className="text-[12.5px] font-medium text-foreground">Approval prompts</div>
                <p className="mt-1 text-[12px] text-muted">
                  Let the agent request approval before changing connected infrastructure or other
                  external systems. Turn this off for findings-and-ticket-only investigations.
                </p>
              </div>
              <Toggle
                checked={data.approvalPromptsEnabled}
                disabled={!investigateOn || save.isPending}
                onChange={(v) => patch({ approvalPromptsEnabled: v })}
              />
            </div>
          </div>
        </FlowNode>

        <FlowConnector active={downstreamEligible && linearConnected} />

        <FlowNode
          step={3}
          title="File Linear ticket"
          status={
            !downstreamEligible ? (
              <Chip tone="muted" dot>
                Skipped
              </Chip>
            ) : linearNeedsReauth ? (
              <Chip tone="warning" dot>
                Reconnect Linear
              </Chip>
            ) : !linearConnected ? (
              <Chip tone="warning" dot>
                Linear not connected
              </Chip>
            ) : (
              <Chip tone="success" dot>
                On handoff
              </Chip>
            )
          }
          spineActive={downstreamEligible && linearConnected}
          off={!downstreamEligible}
        >
          {!linearConnected ? (
            <div className="text-[12.5px] text-muted">
              {linearNeedsReauth
                ? "Reconnect Linear in the Integrations section above to resume ticket filing."
                : "Connect Linear in the Integrations section above to enable ticket filing."}
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-[12.5px] text-muted">
                Each findings-only handoff creates a new Linear ticket with a link back to the
                incident. Paused and failed investigations do not create tickets; resolve-time
                filing is controlled below.
              </p>
              <div className="flex items-start justify-between gap-4 rounded-md border border-border px-3 py-3">
                <div>
                  <div className="text-[12.5px] font-medium text-foreground">
                    Also create a ticket on incident resolution
                  </div>
                  <p className="mt-1 text-[12px] text-muted">
                    Applies when the agent finishes with resolve_incident instead of handing off an
                    open incident.
                  </p>
                </div>
                <Toggle
                  checked={data.createLinearTicketOnResolve}
                  disabled={!downstreamEligible || save.isPending}
                  onChange={(v) => patch({ createLinearTicketOnResolve: v })}
                />
              </div>
              <LinearTicketInstructionsField
                value={data.linearTicketInstructions}
                disabled={!downstreamEligible || save.isPending}
                onSave={(v) => patch({ linearTicketInstructions: v })}
              />
            </div>
          )}
        </FlowNode>

        <FlowConnector
          active={downstreamEligible && githubConnected && data.prPolicy !== "never"}
        />

        <FlowNode
          step={4}
          title="Submit remediation PR"
          headerSlot={
            githubConnected ? (
              <Toggle
                checked={data.prPolicy !== "never"}
                disabled={!downstreamEligible || save.isPending}
                onChange={(v) => patch({ prPolicy: v ? "always" : "never" })}
              />
            ) : undefined
          }
          status={
            !githubConnected ? (
              <Chip tone="warning" dot>
                GitHub not connected
              </Chip>
            ) : undefined
          }
          spineActive={false}
          isLast
          off={!downstreamEligible || data.prPolicy === "never"}
        >
          {!githubConnected ? (
            <div className="text-[12.5px] text-muted">
              Install the Superlog GitHub App in the Integrations section above to allow the agent
              to open pull requests.
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-[12.5px] text-muted">
                When on, the agent opens a pull request whenever it lands on a concrete code area.
                When off, the agent only surfaces findings — no PRs.
              </p>
              <PrBaseBranchField
                value={data.prBaseBranch}
                branches={branches.data?.branches ?? []}
                loading={branches.isLoading}
                loadError={branches.isError}
                disabled={!downstreamEligible || data.prPolicy === "never" || save.isPending}
                onSave={(v) => patch({ prBaseBranch: v })}
              />
              <AutoMergeControls
                policy={data.autoMergeFixPrs}
                method={data.autoMergeMethod}
                disabled={!downstreamEligible || data.prPolicy === "never" || save.isPending}
                onChange={(patchValue) => patch(patchValue)}
              />
            </div>
          )}
        </FlowNode>
      </div>
    </Tile>
  );
}

function InactiveIncidentResolutionSettings({
  projectId,
}: {
  projectId: string | undefined;
}) {
  const settings = useAgentSettings(projectId);
  const save = useSaveAgentSettings(projectId);

  return (
    <InactiveIncidentResolutionCard
      enabled={settings.data?.autoResolveStaleIncidentsEnabled ?? true}
      disabled={!projectId || settings.isLoading || save.isPending}
      onChange={(enabled) => save.mutate({ autoResolveStaleIncidentsEnabled: enabled })}
    />
  );
}

// The empty-string option means "use the repository default branch" — it maps
// to a null prBaseBranch on save.
const REPO_DEFAULT_BRANCH = "";

function PrBaseBranchField({
  value,
  branches,
  loading,
  loadError,
  disabled,
  onSave,
}: {
  value: string | null;
  branches: RepoBranch[];
  loading: boolean;
  loadError: boolean;
  disabled: boolean;
  onSave: (value: string | null) => void;
}) {
  const [draft, setDraft] = useState(value ?? REPO_DEFAULT_BRANCH);
  useEffect(() => setDraft(value ?? REPO_DEFAULT_BRANCH), [value]);
  const dirty = draft !== (value ?? REPO_DEFAULT_BRANCH);

  // Loading/error disable the picker — strict mode means we only ever offer
  // branches we've confirmed exist, so we can't let the user save against a
  // list we couldn't fetch.
  const pickerDisabled = disabled || loading || loadError;

  const options: DropdownOption[] = [
    { value: REPO_DEFAULT_BRANCH, label: "Repository default", searchText: "Repository default" },
    ...branches.map((branch) => ({
      value: branch.name,
      searchText: branch.name,
      label: (
        <span className="flex items-center gap-2">
          <span className="font-sans">{branch.name}</span>
          {branch.isDefault && <span className="text-[11px] text-subtle">default</span>}
        </span>
      ),
    })),
  ];

  return (
    <div className="space-y-2">
      <FieldLabel>PR target branch</FieldLabel>
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="min-w-[260px] flex-1">
          <Dropdown
            value={draft}
            onChange={setDraft}
            disabled={pickerDisabled}
            options={options}
            placeholder={
              loading
                ? "Loading branches…"
                : loadError
                  ? "Couldn't load branches"
                  : "Repository default"
            }
            emptyLabel="No branches found"
          />
        </div>
        <Btn
          size="sm"
          variant="secondary"
          disabled={pickerDisabled || !dirty}
          onClick={() => onSave(draft || null)}
        >
          Save
        </Btn>
      </div>
      <p className="text-[12px] text-muted">
        {loadError
          ? "Couldn't load branches from GitHub — try again, or check the App's repo access."
          : "Pick the branch agent PRs target. Defaults to each repo's default branch."}
      </p>
    </div>
  );
}

type FilterBucket = "includeLogs" | "includeSpans" | "excludeLogs" | "excludeSpans";

const BUCKET_META: Record<
  FilterBucket,
  { label: string; subtitle: string; kind: "log" | "span"; mode: "include" | "exclude" }
> = {
  includeLogs: {
    label: "Include only logs with",
    subtitle: "If set, only error logs that match one of these attributes can create errors.",
    kind: "log",
    mode: "include",
  },
  includeSpans: {
    label: "Include only traces with",
    subtitle: "If set, only exception spans that match one of these attributes can create errors.",
    kind: "span",
    mode: "include",
  },
  excludeLogs: {
    label: "Exclude all logs with",
    subtitle: "Error logs matching any of these are dropped before error creation.",
    kind: "log",
    mode: "exclude",
  },
  excludeSpans: {
    label: "Exclude all traces with",
    subtitle: "Exception spans matching any of these are dropped before error creation.",
    kind: "span",
    mode: "exclude",
  },
};

const BUCKET_ORDER: FilterBucket[] = ["includeLogs", "includeSpans", "excludeLogs", "excludeSpans"];

function configsEqual(a: IssueFilterConfig, b: IssueFilterConfig): boolean {
  for (const bucket of BUCKET_ORDER) {
    if (a[bucket].length !== b[bucket].length) return false;
    for (let i = 0; i < a[bucket].length; i++) {
      if (a[bucket][i]!.key !== b[bucket][i]!.key) return false;
      if (a[bucket][i]!.value !== b[bucket][i]!.value) return false;
    }
  }
  return true;
}

function IssueFilterCard({ projectId }: { projectId: string | undefined }) {
  const settings = useAgentSettings(projectId);
  const save = useSaveAgentSettings(projectId);
  const remote = settings.data?.issueFilterConfig ?? EMPTY_ISSUE_FILTER_CONFIG;
  const [draft, setDraft] = useState<IssueFilterConfig>(EMPTY_ISSUE_FILTER_CONFIG);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!loaded && settings.data) {
      setDraft(settings.data.issueFilterConfig ?? EMPTY_ISSUE_FILTER_CONFIG);
      setLoaded(true);
    }
  }, [settings.data, loaded]);

  const dirty = loaded && !configsEqual(draft, remote);
  const disabled = !projectId || save.isPending || settings.isLoading;
  const preview = useIssueFilterPreview(projectId, draft);

  const addClause = (bucket: FilterBucket, clause: IssueFilterClause) =>
    setDraft((prev) => {
      if (prev[bucket].some((c) => c.key === clause.key && c.value === clause.value)) return prev;
      return { ...prev, [bucket]: [...prev[bucket], clause] };
    });
  const removeClause = (bucket: FilterBucket, idx: number) =>
    setDraft((prev) => ({ ...prev, [bucket]: prev[bucket].filter((_, i) => i !== idx) }));

  const totalClauses = BUCKET_ORDER.reduce((n, b) => n + draft[b].length, 0);

  return (
    <div className="space-y-4">
      <Tile>
        <div className="space-y-4 p-5">
          {BUCKET_ORDER.map((bucket) => (
            <IssueFilterBucket
              key={bucket}
              bucket={bucket}
              clauses={draft[bucket]}
              disabled={disabled}
              projectId={projectId}
              onAdd={(c) => addClause(bucket, c)}
              onRemove={(idx) => removeClause(bucket, idx)}
            />
          ))}
          <div className="rounded-sm border border-border bg-surface-2 p-3 text-[12px] leading-relaxed text-muted">
            <p className="mb-1 font-medium text-fg">How these combine</p>
            <ul className="list-disc space-y-0.5 pl-4">
              <li>
                <b>Exclude wins.</b> An event matching any exclude clause is dropped — even if it
                also matches an include clause.
              </li>
              <li>
                <b>Include is OR within a bucket.</b> If you set any include clauses for a kind, an
                event of that kind must match at least one to create an error.
              </li>
              <li>
                <b>Logs and traces are independent.</b> Filters for "logs" only affect error logs;
                filters for "traces" only affect exception spans.
              </li>
              <li>
                <b>Empty = no constraint.</b> An empty bucket means "let everything through" (for
                include) or "drop nothing extra" (for exclude).
              </li>
              <li>
                Keys are matched case-insensitively across resource, log, and span attributes;
                values are matched exactly.
              </li>
            </ul>
          </div>
          <div className="flex items-center gap-2">
            <Btn
              size="sm"
              variant="primary"
              disabled={!dirty || disabled}
              onClick={() => save.mutate({ issueFilterConfig: draft })}
            >
              Save filter
            </Btn>
            {dirty && (
              <Btn size="sm" variant="ghost" onClick={() => setDraft(remote)}>
                Discard
              </Btn>
            )}
          </div>
        </div>
      </Tile>
      <Tile>
        <div className="space-y-2 p-5">
          <div className="flex items-center justify-between">
            <FieldLabel>
              {totalClauses === 0
                ? "Recent errors (last 24h)"
                : "Errors that would still be created (last 24h)"}
            </FieldLabel>
            {preview.isFetching && <span className="text-[11px] text-subtle">refreshing…</span>}
          </div>
          <IssueFilterPreviewList
            isLoading={preview.isLoading}
            events={preview.data?.events ?? []}
            clauseKeys={collectClauseKeys(draft)}
            totalClauses={totalClauses}
          />
        </div>
      </Tile>
    </div>
  );
}

function collectClauseKeys(config: IssueFilterConfig): Set<string> {
  const out = new Set<string>();
  for (const b of BUCKET_ORDER) {
    for (const c of config[b]) out.add(c.key.toLowerCase());
  }
  return out;
}

function IssueFilterBucket({
  bucket,
  clauses,
  disabled,
  projectId,
  onAdd,
  onRemove,
}: {
  bucket: FilterBucket;
  clauses: IssueFilterClause[];
  disabled: boolean;
  projectId: string | undefined;
  onAdd: (clause: IssueFilterClause) => void;
  onRemove: (idx: number) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const meta = BUCKET_META[bucket];
  return (
    <div className="space-y-2">
      <div>
        <FieldLabel>{meta.label}</FieldLabel>
        <p className="mt-0.5 text-[12px] text-subtle">{meta.subtitle}</p>
      </div>
      <div className="relative flex min-h-[40px] flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-2 p-2">
        {clauses.length === 0 && (
          <span className="px-1 text-[12.5px] text-subtle">
            {meta.mode === "include" ? "Any" : "Nothing"} — no constraint.
          </span>
        )}
        {clauses.map((clause, i) => (
          <FilterPill
            key={`${clause.key}=${clause.value}`}
            clause={clause}
            tone={meta.mode}
            onRemove={() => onRemove(i)}
            disabled={disabled}
          />
        ))}
        <div className="relative">
          <button
            type="button"
            onClick={() => setPickerOpen((v) => !v)}
            disabled={disabled}
            className="inline-flex h-6 items-center gap-1 rounded-sm border border-dashed border-border px-2 text-[11.5px] text-muted hover:border-border-strong hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span aria-hidden>+</span> Add tag
          </button>
          {pickerOpen && projectId && (
            <IssueFilterPicker
              projectId={projectId}
              existing={clauses}
              onPick={(c) => {
                onAdd(c);
                setPickerOpen(false);
              }}
              onClose={() => setPickerOpen(false)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function FilterPill({
  clause,
  tone = "include",
  onRemove,
  disabled,
}: {
  clause: IssueFilterClause;
  tone?: "include" | "exclude";
  onRemove: () => void;
  disabled: boolean;
}) {
  const accent =
    tone === "exclude"
      ? "border-[color:var(--color-danger-border,theme(colors.red.700))] bg-[color:var(--color-danger-soft,theme(colors.red.950))]"
      : "";
  return (
    <span
      className={`inline-flex h-6 items-center gap-1 rounded-sm border border-border bg-surface px-2 text-[11.5px] text-fg ${accent}`}
    >
      <span className="font-sans text-subtle">{clause.key}</span>
      <span className="text-subtle">=</span>
      <span className="font-sans">{clause.value}</span>
      <button
        type="button"
        disabled={disabled}
        onClick={onRemove}
        className="ml-0.5 text-subtle hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
        aria-label="Remove filter"
      >
        ×
      </button>
    </span>
  );
}

function IssueFilterPicker({
  projectId,
  existing,
  onPick,
  onClose,
}: {
  projectId: string;
  existing: IssueFilterClause[];
  onPick: (c: IssueFilterClause) => void;
  onClose: () => void;
}) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [drillKey, setDrillKey] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [highlight, setHighlight] = useState(0);

  const keys = useIssueFilterAttributeKeys(projectId);
  const values = useIssueFilterAttributeValues(projectId, drillKey ?? undefined);

  useEffect(() => setHighlight(0), [search, drillKey]);
  useEffect(() => {
    searchInputRef.current?.focus();
  }, [drillKey]);

  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (!popoverRef.current) return;
      const target = e.target as Node;
      if (popoverRef.current.contains(target)) return;
      const trigger = popoverRef.current.parentElement?.querySelector("button");
      if (trigger && trigger.contains(target)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const existingPairs = useMemo(
    () => new Set(existing.map((c) => `${c.key}=${c.value}`)),
    [existing],
  );
  const q = search.trim().toLowerCase();

  const className =
    "absolute left-0 top-full z-50 mt-2 w-80 overflow-hidden rounded-lg border border-border bg-surface shadow-[0_10px_30px_-10px_rgba(0,0,0,0.4)]";

  if (drillKey) {
    const rows = (values.data ?? []).filter((r) => r.value.toLowerCase().includes(q));
    const pickAt = (idx: number) => {
      const r = rows[idx];
      if (!r) return;
      if (existingPairs.has(`${drillKey}=${r.value}`)) return;
      onPick({ key: drillKey, value: r.value });
    };
    return (
      <div ref={popoverRef} className={className}>
        <div className="border-b border-border px-2.5 pb-2 pt-2.5">
          <button
            type="button"
            onClick={() => {
              setDrillKey(null);
              setSearch("");
            }}
            className="mb-1.5 flex items-center gap-1.5 text-[11px] text-subtle hover:text-fg"
          >
            ← <span className="truncate font-sans">{drillKey}</span>
          </button>
          <input
            ref={searchInputRef}
            placeholder="Filter values…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setHighlight((h) => Math.min(h + 1, Math.max(rows.length - 1, 0)));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setHighlight((h) => Math.max(h - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                pickAt(highlight);
              } else if (e.key === "Tab" && search === "") {
                e.preventDefault();
                onPick({ key: drillKey, value: "" });
              }
            }}
            autoFocus
            className="h-7 w-full rounded-lg border border-border bg-surface-2 px-2 text-[12px] text-fg placeholder:text-subtle focus:border-border-strong focus:outline-none"
          />
        </div>
        <div className="max-h-72 overflow-y-auto">
          {values.isLoading ? (
            <div className="px-3 py-6 text-center text-[12px] text-subtle">loading…</div>
          ) : rows.length === 0 ? (
            <div className="px-3 py-6 text-center text-[12px] text-subtle">
              {q ? `No values match “${q}”` : "No values seen in the last 24h"}
            </div>
          ) : (
            <ul>
              {rows.map((r, i) => {
                const already = existingPairs.has(`${drillKey}=${r.value}`);
                return (
                  <li key={r.value}>
                    <button
                      type="button"
                      disabled={already}
                      onMouseEnter={() => setHighlight(i)}
                      onClick={() => pickAt(i)}
                      className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[12px] ${
                        highlight === i ? "bg-surface-2" : ""
                      } ${already ? "cursor-not-allowed opacity-50" : "hover:bg-surface-2"}`}
                    >
                      <span className="truncate font-sans text-fg">{r.value || "(empty)"}</span>
                      <span className="shrink-0 text-[10px] text-subtle">
                        {already ? "added" : r.count}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    );
  }

  const keyRows = (keys.data ?? []).filter((k) => k.key.toLowerCase().includes(q));
  const pickAt = (idx: number) => {
    const k = keyRows[idx];
    if (!k) return;
    setDrillKey(k.key);
    setSearch("");
  };

  return (
    <div ref={popoverRef} className={className}>
      <div className="border-b border-border px-2.5 pb-2 pt-2.5">
        <input
          ref={searchInputRef}
          placeholder="Find an attribute…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setHighlight((h) => Math.min(h + 1, Math.max(keyRows.length - 1, 0)));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHighlight((h) => Math.max(h - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              pickAt(highlight);
            }
          }}
          autoFocus
          className="h-7 w-full rounded-lg border border-border bg-surface-2 px-2 text-[12px] text-fg placeholder:text-subtle focus:border-border-strong focus:outline-none"
        />
      </div>
      <div className="max-h-72 overflow-y-auto">
        {keys.isLoading ? (
          <div className="px-3 py-6 text-center text-[12px] text-subtle">loading…</div>
        ) : keyRows.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12px] text-subtle">
            {q
              ? `No attributes match “${q}”`
              : "No telemetry in the last 24h — nothing to suggest yet."}
          </div>
        ) : (
          <ul>
            {keyRows.map((k, i) => (
              <li key={k.key}>
                <button
                  type="button"
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => pickAt(i)}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-surface-2 ${
                    highlight === i ? "bg-surface-2" : ""
                  }`}
                >
                  <span className="truncate font-sans text-fg">{k.key}</span>
                  <span className="shrink-0 text-[10px] text-subtle">{k.count} ›</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function IssueFilterPreviewList({
  isLoading,
  events,
  clauseKeys,
  totalClauses,
}: {
  isLoading: boolean;
  events: IssueFilterPreviewEvent[];
  clauseKeys: Set<string>;
  totalClauses: number;
}) {
  if (isLoading) {
    return <div className="px-2 py-6 text-center text-[12px] text-subtle">loading…</div>;
  }
  if (events.length === 0) {
    return (
      <div className="px-2 py-6 text-center text-[12px] text-subtle">
        {totalClauses === 0
          ? "No errors in the last 24h."
          : "No errors in the last 24h survive this filter — saving will silence every recent error."}
      </div>
    );
  }
  return (
    <ul className="divide-y divide-border">
      {events.map((e, i) => (
        <li key={`${e.ts}-${i}`} className="space-y-1 py-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-[11px] text-subtle">
              <Chip tone={e.kind === "log" ? "warning" : "danger"}>{e.kind}</Chip>
              <span className="font-sans">{e.service || "(no service)"}</span>
              {e.exception_type && <span className="font-sans text-muted">{e.exception_type}</span>}
            </div>
            <span className="font-sans text-[10px] text-subtle">{formatRelative(e.ts)}</span>
          </div>
          <div className="line-clamp-2 break-words font-sans text-[12px] text-fg">
            {e.message || "(no message)"}
          </div>
          <div className="flex flex-wrap gap-1">
            {pickPreviewAttrs(e.attrs, clauseKeys).map(([k, v]) => (
              <span
                key={`${k}=${v}`}
                className="inline-flex items-center gap-1 rounded-sm border border-border bg-surface-2 px-1.5 py-0.5 font-sans text-[10.5px] text-muted"
              >
                <span className="text-subtle">{k}</span>
                <span className="text-subtle">=</span>
                <span className="text-fg">{v}</span>
              </span>
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}

// Surface clause-relevant attrs first so the user can sanity-check the match.
function pickPreviewAttrs(
  attrs: Record<string, string>,
  clauseKeys: Set<string>,
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const [k, v] of Object.entries(attrs)) {
    if (clauseKeys.has(k.toLowerCase())) {
      out.push([k, v]);
      seen.add(k);
    }
  }
  // Pad with a couple of useful defaults if we have room.
  const defaults = ["env", "deployment.environment.name", "service.name"];
  for (const k of defaults) {
    if (out.length >= 4) break;
    if (seen.has(k)) continue;
    const v = attrs[k];
    if (v) {
      out.push([k, v]);
      seen.add(k);
    }
  }
  return out;
}

function formatRelative(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function FlowNode({
  step,
  title,
  status,
  headerSlot,
  children,
  spineActive,
  accent = false,
  off = false,
  isLast = false,
  headerOnly = false,
}: {
  step: number;
  title: string;
  status?: ReactNode;
  headerSlot?: ReactNode;
  children?: ReactNode;
  spineActive: boolean;
  accent?: boolean;
  off?: boolean;
  isLast?: boolean;
  headerOnly?: boolean;
}) {
  const dim = off ? "opacity-50" : "";
  return (
    <div className={`relative grid grid-cols-[40px_1fr] gap-4 ${dim}`}>
      <div className="relative flex flex-col items-center">
        <div
          className={`flex h-8 w-8 items-center justify-center rounded-full border font-sans text-[11px] tabular-nums ${
            off
              ? "border-border bg-surface-2 text-muted"
              : accent && spineActive
                ? "border-accent bg-accent-soft text-accent"
                : spineActive
                  ? "border-border-strong bg-surface-2 text-fg"
                  : "border-border bg-surface-2 text-muted"
          }`}
        >
          {step}
        </div>
        {!isLast && (
          <div
            className={`mt-1 w-px flex-1 ${spineActive && !off ? "bg-border-strong" : "bg-border"}`}
          />
        )}
      </div>
      <div className={`min-w-0 ${isLast || headerOnly ? "pb-0" : "pb-6"}`}>
        <div className={`flex items-center gap-3 ${headerOnly ? "h-8" : "mb-3"}`}>
          <h3 className="text-[14px] font-medium text-fg">{title}</h3>
          {headerSlot ? <div className="shrink-0">{headerSlot}</div> : null}
          {!headerSlot && status ? <div className="ml-auto shrink-0">{status}</div> : null}
        </div>
        {!headerOnly && (
          <div className="rounded-sm border border-border bg-surface-2/40 p-4">{children}</div>
        )}
      </div>
    </div>
  );
}

function FlowConnector({ active }: { active: boolean }) {
  return (
    <div className="relative grid grid-cols-[40px_1fr] gap-4">
      <div className="flex justify-center">
        <div className={`h-4 w-px ${active ? "bg-border-strong" : "bg-border"}`} />
      </div>
      <div />
    </div>
  );
}

function AutoMergeControls({
  policy,
  method,
  disabled,
  onChange,
}: {
  policy: AutoMergePolicy;
  method: AutoMergeMethod;
  disabled: boolean;
  onChange: (patch: {
    autoMergeFixPrs?: AutoMergePolicy;
    autoMergeMethod?: AutoMergeMethod;
  }) => void;
}) {
  const policyOptions: AutoMergePolicy[] = ["never", "when_checks_pass", "immediately"];
  const policyLabels: Record<AutoMergePolicy, string> = {
    never: "Off — leave PR open",
    when_checks_pass: "When required checks pass",
    immediately: "Immediately",
  };
  const policyHints: Record<AutoMergePolicy, string> = {
    never: "The agent opens the PR and stops. A human reviews and merges.",
    when_checks_pass:
      "Uses GitHub's native auto-merge: the PR lands once required checks and reviews pass. Requires auto-merge to be enabled on the repo.",
    immediately:
      "Merges right after the PR is opened. Will fail if branch protection blocks it — the PR is left open in that case.",
  };
  const methodOptions: AutoMergeMethod[] = ["squash", "merge", "rebase"];
  const methodLabels: Record<AutoMergeMethod, string> = {
    squash: "Squash and merge",
    merge: "Create a merge commit",
    rebase: "Rebase and merge",
  };
  return (
    <div className="space-y-3 rounded-sm border border-border bg-surface-2 p-3">
      <div className="text-[11px] font-sans uppercase tracking-tight text-muted">
        Auto-merge fix PRs
      </div>
      <div className="flex flex-wrap gap-1.5">
        {policyOptions.map((opt) => {
          const active = policy === opt;
          return (
            <button
              key={opt}
              type="button"
              disabled={disabled}
              onClick={() => onChange({ autoMergeFixPrs: opt })}
              className={`rounded-sm border px-2.5 py-1 font-sans text-[11px] tracking-tight transition-colors ${
                active
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-border bg-surface-2 text-muted hover:text-fg"
              } ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
            >
              {policyLabels[opt]}
            </button>
          );
        })}
      </div>
      <p className="text-[12px] text-muted">{policyHints[policy]}</p>
      {policy !== "never" && (
        <div className="space-y-2">
          <div className="text-[11px] font-sans uppercase tracking-tight text-muted">
            Merge method
          </div>
          <div className="flex flex-wrap gap-1.5">
            {methodOptions.map((opt) => {
              const active = method === opt;
              return (
                <button
                  key={opt}
                  type="button"
                  disabled={disabled}
                  onClick={() => onChange({ autoMergeMethod: opt })}
                  className={`rounded-sm border px-2.5 py-1 font-sans text-[11px] tracking-tight transition-colors ${
                    active
                      ? "border-accent bg-accent-soft text-accent"
                      : "border-border bg-surface-2 text-muted hover:text-fg"
                  } ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
                >
                  {methodLabels[opt]}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function InstructionsField({
  value,
  disabled,
  onSave,
}: {
  value: string;
  disabled: boolean;
  onSave: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState(value.length > 0);

  useEffect(() => {
    if (!loaded) {
      setDraft(value);
      setLoaded(true);
      if (value.length > 0) setExpanded(true);
    }
  }, [value, loaded]);

  const dirty = loaded && draft !== value;

  if (!expanded) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setExpanded(true)}
        className={`inline-flex items-center gap-1.5 text-[12px] text-muted hover:text-fg ${
          disabled ? "cursor-not-allowed opacity-50 hover:text-muted" : ""
        }`}
      >
        <span aria-hidden>+</span> Add custom instructions
      </button>
    );
  }

  return (
    <div className="space-y-2">
      <FieldLabel>Custom instructions</FieldLabel>
      <textarea
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        rows={6}
        placeholder={
          "e.g. Prefer one-line fixes when possible. When patching the billing service, run pnpm typecheck before declaring the patch validated."
        }
        className="w-full rounded-lg border border-border bg-surface-2 p-3 font-sans text-[12.5px] text-fg placeholder:text-subtle focus:border-border-strong focus:outline-none disabled:opacity-60"
      />
      <div className="flex items-center justify-between text-[12px] text-muted">
        <span>Appended to every agent run prompt for this workspace.</span>
        <span className="font-sans tabular-nums">{draft.length} / 8000</span>
      </div>
      <div className="flex items-center gap-2">
        <Btn
          size="sm"
          variant="primary"
          disabled={!dirty || disabled}
          onClick={() => onSave(draft)}
        >
          Save instructions
        </Btn>
        {dirty && (
          <Btn size="sm" variant="ghost" onClick={() => setDraft(value)}>
            Discard
          </Btn>
        )}
        {!dirty && value.length === 0 && (
          <Btn size="sm" variant="ghost" onClick={() => setExpanded(false)}>
            Cancel
          </Btn>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Linear ticket custom instructions
// ---------------------------------------------------------------------------

function LinearTicketInstructionsField({
  value,
  disabled,
  onSave,
}: {
  value: LinearTicketInstruction[];
  disabled: boolean;
  onSave: (v: LinearTicketInstruction[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftText, setDraftText] = useState("");

  function openAdd() {
    setEditingId(null);
    setDraftTitle("");
    setDraftText("");
    setAdding(true);
  }

  function openEdit(item: LinearTicketInstruction) {
    setAdding(false);
    setEditingId(item.id);
    setDraftTitle(item.title);
    setDraftText(item.text);
  }

  function cancelForm() {
    setAdding(false);
    setEditingId(null);
  }

  function saveAdd() {
    if (!draftTitle.trim()) return;
    const updated = [
      ...value,
      { id: crypto.randomUUID(), title: draftTitle.trim(), text: draftText.trim() },
    ];
    onSave(updated);
    setAdding(false);
  }

  function saveEdit() {
    if (!draftTitle.trim() || !editingId) return;
    onSave(
      value.map((item) =>
        item.id === editingId
          ? { ...item, title: draftTitle.trim(), text: draftText.trim() }
          : item,
      ),
    );
    setEditingId(null);
  }

  function remove(id: string) {
    onSave(value.filter((item) => item.id !== id));
  }

  const formActive = adding || editingId !== null;

  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <div className="space-y-1">
          {value.map((item) =>
            editingId === item.id ? (
              <InstructionForm
                key={item.id}
                title={draftTitle}
                text={draftText}
                disabled={disabled}
                onTitleChange={setDraftTitle}
                onTextChange={setDraftText}
                onSave={saveEdit}
                onCancel={cancelForm}
              />
            ) : (
              <div
                key={item.id}
                className="flex items-start gap-2 rounded-sm border border-border bg-surface-2 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    disabled={disabled || formActive}
                    onClick={() => openEdit(item)}
                    className="text-left text-[12.5px] font-medium text-fg hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {item.title}
                  </button>
                  {item.text && (
                    <p className="mt-0.5 line-clamp-2 text-[12px] text-muted">{item.text}</p>
                  )}
                </div>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => remove(item.id)}
                  className="shrink-0 text-[13px] text-muted hover:text-fg disabled:opacity-40"
                  aria-label="Remove instruction"
                >
                  ×
                </button>
              </div>
            ),
          )}
        </div>
      )}
      {adding && (
        <InstructionForm
          title={draftTitle}
          text={draftText}
          disabled={disabled}
          onTitleChange={setDraftTitle}
          onTextChange={setDraftText}
          onSave={saveAdd}
          onCancel={cancelForm}
        />
      )}
      {!formActive && (
        <button
          type="button"
          disabled={disabled}
          onClick={openAdd}
          className={`inline-flex items-center gap-1.5 text-[12px] text-muted hover:text-fg ${
            disabled ? "cursor-not-allowed opacity-50 hover:text-muted" : ""
          }`}
        >
          <span aria-hidden>+</span> Add ticket instructions
        </button>
      )}
    </div>
  );
}

function InstructionForm({
  title,
  text,
  disabled,
  onTitleChange,
  onTextChange,
  onSave,
  onCancel,
}: {
  title: string;
  text: string;
  disabled: boolean;
  onTitleChange: (v: string) => void;
  onTextChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="space-y-2 rounded-sm border border-border bg-surface-2 p-3">
      <Input
        value={title}
        disabled={disabled}
        onChange={(e) => onTitleChange(e.target.value)}
        placeholder="Instruction title"
        className="text-[12.5px]"
      />
      <textarea
        value={text}
        disabled={disabled}
        onChange={(e) => onTextChange(e.target.value)}
        rows={3}
        placeholder="Describe the requirement the agent must follow when filing this ticket…"
        className="w-full rounded-lg border border-border bg-surface-1 p-2 font-sans text-[12px] text-fg placeholder:text-subtle focus:border-border-strong focus:outline-none disabled:opacity-60"
      />
      <div className="flex items-center gap-2">
        <Btn size="sm" variant="primary" disabled={!title.trim() || disabled} onClick={onSave}>
          Save
        </Btn>
        <Btn size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Btn>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tools (custom integrations)
// ---------------------------------------------------------------------------

function ToolsSection({ disabled }: { disabled: boolean }) {
  const { data, isLoading, isError } = useIntegrations();
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const integrations = data?.integrations ?? [];
  const installed = integrations.filter((i) => i.installed);
  const available = integrations.filter((i) => !i.installed);

  return (
    <div className="space-y-2">
      <FieldLabel>Tools</FieldLabel>
      <div className="flex flex-wrap items-center gap-2">
        {installed.map((integration) => {
          const missing = integration.required_secrets.filter((s) => !s.present);
          return (
            <button
              key={integration.slug}
              type="button"
              disabled={disabled}
              onClick={() => setOpenSlug(integration.slug)}
              className={`inline-flex items-center gap-2 rounded-sm border px-2.5 py-1 text-[12px] transition ${
                disabled
                  ? "cursor-not-allowed opacity-50"
                  : "hover:border-border-strong hover:bg-surface-2"
              } ${missing.length > 0 ? "border-warning/60" : "border-border"}`}
            >
              <span className="font-medium text-fg">{integration.name}</span>
              {missing.length > 0 ? (
                <Chip tone="warning" dot>
                  Key missing
                </Chip>
              ) : integration.enabled ? (
                <Chip tone="success" dot>
                  On
                </Chip>
              ) : (
                <Chip tone="muted" dot>
                  Off
                </Chip>
              )}
            </button>
          );
        })}
        {available.length > 0 && !adding && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => setAdding(true)}
            className={`inline-flex items-center gap-1.5 text-[12px] text-muted hover:text-fg ${
              disabled ? "cursor-not-allowed opacity-50 hover:text-muted" : ""
            }`}
          >
            <span aria-hidden>+</span> Add tools
          </button>
        )}
        {isError && <span className="text-[12px] text-warning">Could not load tools.</span>}
      </div>
      {adding && (
        <AddToolsPanel
          available={available}
          onPick={(slug) => {
            setAdding(false);
            setOpenSlug(slug);
          }}
          onClose={() => setAdding(false)}
        />
      )}
      {openSlug && (
        <IntegrationEditor
          integration={integrations.find((i) => i.slug === openSlug) ?? null}
          onClose={() => setOpenSlug(null)}
        />
      )}
      <p className="text-[12px] text-muted">
        Tools let the agent call third-party APIs during agent runs. Keys are encrypted at rest and
        never sent to the model — the worker substitutes them server-side at request time.
      </p>
    </div>
  );
}

function AddToolsPanel({
  available,
  onPick,
  onClose,
}: {
  available: Integration[];
  onPick: (slug: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="rounded-sm border border-border bg-surface-2 p-3">
      <div className="mb-2 flex items-center justify-between">
        <FieldLabel>Available tools</FieldLabel>
        <Btn size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Btn>
      </div>
      <div className="grid gap-2">
        {available.map((integration) => (
          <button
            key={integration.slug}
            type="button"
            onClick={() => onPick(integration.slug)}
            className="flex flex-col gap-1 rounded-sm border border-border bg-surface p-3 text-left transition hover:border-border-strong"
          >
            <span className="text-[13px] font-medium text-fg">{integration.name}</span>
            <span className="text-[12px] text-muted">{integration.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function IntegrationEditor({
  integration,
  onClose,
}: {
  integration: Integration | null;
  onClose: () => void;
}) {
  const save = useSaveIntegration();
  const remove = useRemoveIntegration();
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [enabled, setEnabled] = useState<boolean>(integration?.enabled ?? true);

  useEffect(() => {
    if (integration) setEnabled(integration.enabled);
  }, [integration]);

  if (!integration) return null;

  const missing = integration.required_secrets.filter((s) => !s.present);
  const newlyFilled = integration.required_secrets.filter(
    (s) => !s.present && (secrets[s.name]?.length ?? 0) > 0,
  );
  const stillMissing = missing.filter((s) => (secrets[s.name]?.length ?? 0) === 0);
  const hasChanges =
    Object.values(secrets).some((v) => v.length > 0) ||
    enabled !== integration.enabled ||
    !integration.installed;
  const canSave = hasChanges && stillMissing.length === 0 && !save.isPending && !remove.isPending;

  return (
    <div className="rounded-sm border border-border bg-surface-2 p-3">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <div className="text-[13px] font-medium text-fg">{integration.name}</div>
          <div className="text-[12px] text-muted">{integration.description}</div>
        </div>
        <div className="flex items-center gap-2">
          <span className="font-sans text-[11px] uppercase tracking-[0.15em] text-muted">
            {enabled ? "On" : "Off"}
          </span>
          <Toggle checked={enabled} onChange={setEnabled} disabled={save.isPending} />
        </div>
      </div>
      <div className="space-y-3">
        {integration.required_secrets.map((spec) => (
          <div key={spec.name} className="space-y-1">
            <FieldLabel>{spec.name}</FieldLabel>
            <Input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={spec.present ? "•••••••• stored — type to replace" : "Paste key"}
              value={secrets[spec.name] ?? ""}
              onChange={(e) => setSecrets((s) => ({ ...s, [spec.name]: e.target.value }))}
              className="font-sans"
            />
            <div className="text-[12px] text-muted">{spec.description}</div>
          </div>
        ))}
      </div>
      <div className="mt-4 flex items-center gap-2">
        <Btn
          size="sm"
          variant="primary"
          disabled={!canSave}
          onClick={() => {
            const payload: Record<string, string | null> = {};
            for (const [k, v] of Object.entries(secrets)) {
              if (v.length > 0) payload[k] = v;
            }
            save.mutate(
              {
                slug: integration.slug,
                enabled,
                secrets: Object.keys(payload).length > 0 ? payload : undefined,
              },
              {
                onSuccess: () => {
                  setSecrets({});
                  onClose();
                },
              },
            );
          }}
        >
          {integration.installed ? "Save" : "Install"}
        </Btn>
        <Btn size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Btn>
        {integration.installed && (
          <Btn
            size="sm"
            variant="ghost"
            disabled={remove.isPending}
            onClick={() => {
              remove.mutate(integration.slug, { onSuccess: onClose });
            }}
            className="ml-auto text-warning"
          >
            Remove
          </Btn>
        )}
      </div>
      {newlyFilled.length === 0 && stillMissing.length > 0 && (
        <p className="mt-2 text-[12px] text-warning">
          {stillMissing.length === 1
            ? `Required: ${stillMissing[0]?.name}`
            : `Required: ${stillMissing.map((s) => s.name).join(", ")}`}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

function ApiKeysCard({ projectId }: { projectId: string | undefined }) {
  const keys = useKeys(projectId);
  const create = useCreateKey(projectId ?? "");
  const revoke = useRevokeKey(projectId ?? "");
  const [name, setName] = useState("");
  const [reveal, setReveal] = useState<{ id: string; plaintext: string } | null>(null);

  const live = useMemo(() => (keys.data ?? []).filter((k) => !k.revokedAt), [keys.data]);

  return (
    <Tile>
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[220px] flex-1">
            <FieldLabel>New key name</FieldLabel>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="ci-ingest" />
          </div>
          <Btn
            size="md"
            variant="primary"
            disabled={!projectId || create.isPending}
            loading={create.isPending}
            onClick={async () => {
              if (!projectId) return;
              const created = await create.mutateAsync(name.trim() || "new key");
              if (created.plaintext) {
                setReveal({ id: created.id, plaintext: created.plaintext });
              }
              setName("");
            }}
          >
            Create key
          </Btn>
        </div>

        {reveal && (
          <div className="rounded-sm border border-accent/40 bg-accent-soft/30 p-3">
            <div className="mb-1 flex items-center justify-between">
              <Label>Copy this now — it will not be shown again</Label>
              <button
                type="button"
                onClick={() => setReveal(null)}
                className="text-[11px] text-muted hover:text-fg"
              >
                dismiss
              </button>
            </div>
            <code className="block break-all font-sans text-[12.5px] text-fg">
              {reveal.plaintext}
            </code>
          </div>
        )}

        <div className="border-t border-border">
          {keys.isLoading ? (
            <div className="py-6 text-center text-[12px] text-muted">Loading…</div>
          ) : live.length === 0 ? (
            <div className="py-6 text-center text-[12px] text-muted">
              No active keys for this project.
            </div>
          ) : (
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-border text-left text-muted">
                  <th className="py-2 pr-4 font-sans text-[10px] uppercase tracking-[0.2em]">
                    Name
                  </th>
                  <th className="py-2 pr-4 font-sans text-[10px] uppercase tracking-[0.2em]">
                    Prefix
                  </th>
                  <th className="py-2 pr-4 font-sans text-[10px] uppercase tracking-[0.2em]">
                    Last used
                  </th>
                  <th className="py-2 font-sans text-[10px] uppercase tracking-[0.2em]" />
                </tr>
              </thead>
              <tbody>
                {live.map((k) => (
                  <tr key={k.id} className="border-b border-border last:border-0">
                    <td className="py-3 pr-4">{k.name}</td>
                    <td className="py-3 pr-4 font-sans tabular-nums text-muted">{k.keyPrefix}…</td>
                    <td className="py-3 pr-4 text-muted">
                      {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : "never"}
                    </td>
                    <td className="py-3 text-right">
                      <button
                        type="button"
                        title="Revoke key"
                        aria-label="Revoke key"
                        disabled={revoke.isPending}
                        onClick={() => revoke.mutate(k.id)}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden
                        >
                          <path d="M3 6h18" />
                          <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          <path d="M19 6 18 20a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                          <path d="M10 11v6M14 11v6" />
                        </svg>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Tile>
  );
}

const MCP_EXPIRY_OPTIONS: DropdownOption[] = [
  { value: "never", label: "Never" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
];

function McpTokensCard({ projectId }: { projectId: string | undefined }) {
  const tokens = useMcpTokens();
  const projectsQ = useOrgProjects();
  const create = useCreateMcpToken();
  const revoke = useRevokeMcpToken();

  const projects = projectsQ.data?.projects ?? [];
  const [name, setName] = useState("");
  const [selectedProject, setSelectedProject] = useState<string>("");
  const [expiry, setExpiry] = useState<"never" | "30d" | "90d">("never");
  const [reveal, setReveal] = useState<{ plaintext: string } | null>(null);

  // Default the project picker to the section's active project once known.
  useEffect(() => {
    if (!selectedProject && projectId) setSelectedProject(projectId);
  }, [projectId, selectedProject]);

  const projectOptions: DropdownOption[] = projects.map((p) => ({ value: p.id, label: p.name }));
  const effectiveProject = selectedProject || projectId || projects[0]?.id || "";

  const live = useMemo(
    () => (tokens.data?.tokens ?? []).filter((t) => !t.revokedAt),
    [tokens.data],
  );

  return (
    <Tile>
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[180px] flex-1">
            <FieldLabel>Token name</FieldLabel>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-laptop" />
          </div>
          <div className="w-44">
            <FieldLabel>Default project</FieldLabel>
            <Dropdown
              value={effectiveProject}
              onChange={setSelectedProject}
              options={projectOptions}
              placeholder="Select…"
            />
          </div>
          <div className="w-32">
            <FieldLabel>Expires</FieldLabel>
            <Dropdown
              value={expiry}
              onChange={(v) => setExpiry(v as "never" | "30d" | "90d")}
              options={MCP_EXPIRY_OPTIONS}
            />
          </div>
          <Btn
            size="md"
            variant="primary"
            disabled={!effectiveProject || create.isPending}
            loading={create.isPending}
            onClick={async () => {
              if (!effectiveProject) return;
              const res = await create.mutateAsync({
                name: name.trim() || "MCP token",
                projectId: effectiveProject,
                expiry,
              });
              setReveal({ plaintext: res.token.plaintext });
              setName("");
            }}
          >
            Create token
          </Btn>
        </div>

        {reveal && (
          <div className="rounded-sm border border-accent/40 bg-accent-soft/30 p-3">
            <div className="mb-1 flex items-center justify-between">
              <Label>Copy this now — it will not be shown again</Label>
              <button
                type="button"
                onClick={() => setReveal(null)}
                className="text-[11px] text-muted hover:text-fg"
              >
                dismiss
              </button>
            </div>
            <code className="block break-all font-sans text-[12.5px] text-fg">
              {reveal.plaintext}
            </code>
            <p className="mt-2 text-[12px] text-muted">Add it to your agent, for example:</p>
            <code className="mt-1 block break-all font-sans text-[12px] text-subtle">
              claude mcp add --transport http superlog https://api.superlog.sh/mcp --header
              "Authorization: Bearer {reveal.plaintext}"
            </code>
          </div>
        )}

        <div className="border-t border-border">
          {tokens.isLoading ? (
            <div className="py-6 text-center text-[12px] text-muted">Loading…</div>
          ) : live.length === 0 ? (
            <div className="py-6 text-center text-[12px] text-muted">
              No active MCP tokens. Create one above, or connect via the browser OAuth flow instead.
            </div>
          ) : (
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-border text-left text-muted">
                  <th className="py-2 pr-4 font-sans text-[10px] uppercase tracking-[0.2em]">
                    Name
                  </th>
                  <th className="py-2 pr-4 font-sans text-[10px] uppercase tracking-[0.2em]">
                    Project
                  </th>
                  <th className="py-2 pr-4 font-sans text-[10px] uppercase tracking-[0.2em]">
                    Expires
                  </th>
                  <th className="py-2 pr-4 font-sans text-[10px] uppercase tracking-[0.2em]">
                    Last used
                  </th>
                  <th className="py-2 font-sans text-[10px] uppercase tracking-[0.2em]" />
                </tr>
              </thead>
              <tbody>
                {live.map((t) => (
                  <tr key={t.id} className="border-b border-border last:border-0">
                    <td className="py-3 pr-4">
                      <div>{t.name}</div>
                      <div className="font-sans text-[11px] text-muted">{t.tokenPrefix}…</div>
                    </td>
                    <td className="py-3 pr-4 text-muted">{t.projectName ?? "—"}</td>
                    <td className="py-3 pr-4 text-muted">
                      {t.expiresAt ? new Date(t.expiresAt).toLocaleDateString() : "never"}
                    </td>
                    <td className="py-3 pr-4 text-muted">
                      {t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString() : "never"}
                    </td>
                    <td className="py-3 text-right">
                      <button
                        type="button"
                        title="Revoke token"
                        aria-label="Revoke token"
                        disabled={revoke.isPending}
                        onClick={() => revoke.mutate(t.id)}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden
                        >
                          <path d="M3 6h18" />
                          <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          <path d="M19 6 18 20a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                          <path d="M10 11v6M14 11v6" />
                        </svg>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Tile>
  );
}

function OrgApiKeysCard() {
  const list = useOrgApiKeys();
  const mint = useMintOrgApiKey();
  const revoke = useRevokeOrgApiKey();
  const [name, setName] = useState("");
  const [reveal, setReveal] = useState<{ id: string; plaintext: string } | null>(null);

  const live = useMemo(() => (list.data?.keys ?? []).filter((k) => !k.revoked_at), [list.data]);

  return (
    <Tile>
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[220px] flex-1">
            <FieldLabel>New key name</FieldLabel>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="production-backend"
            />
          </div>
          <Btn
            size="md"
            variant="primary"
            disabled={mint.isPending}
            loading={mint.isPending}
            onClick={async () => {
              const res = await mint.mutateAsync(name.trim() || "management key");
              setReveal({ id: res.key.id, plaintext: res.key.plaintext });
              setName("");
            }}
          >
            Create key
          </Btn>
        </div>

        {reveal && (
          <div className="rounded-sm border border-accent/40 bg-accent-soft/30 p-3">
            <div className="mb-1 flex items-center justify-between">
              <Label>Copy this now — it will not be shown again</Label>
              <button
                type="button"
                onClick={() => setReveal(null)}
                className="text-[11px] text-muted hover:text-fg"
              >
                dismiss
              </button>
            </div>
            <code className="block break-all font-sans text-[12.5px] text-fg">
              {reveal.plaintext}
            </code>
          </div>
        )}

        <div className="border-t border-border">
          {list.isLoading ? (
            <div className="py-6 text-center text-[12px] text-muted">Loading…</div>
          ) : live.length === 0 ? (
            <div className="py-6 text-center text-[12px] text-muted">
              No active management keys.
            </div>
          ) : (
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-border text-left text-muted">
                  <th className="py-2 pr-4 font-sans text-[10px] uppercase tracking-[0.2em]">
                    Name
                  </th>
                  <th className="py-2 pr-4 font-sans text-[10px] uppercase tracking-[0.2em]">
                    Prefix
                  </th>
                  <th className="py-2 pr-4 font-sans text-[10px] uppercase tracking-[0.2em]">
                    Last used
                  </th>
                  <th className="py-2 font-sans text-[10px] uppercase tracking-[0.2em]" />
                </tr>
              </thead>
              <tbody>
                {live.map((k) => (
                  <tr key={k.id} className="border-b border-border last:border-0">
                    <td className="py-3 pr-4">{k.name}</td>
                    <td className="py-3 pr-4 font-sans tabular-nums text-muted">{k.key_prefix}…</td>
                    <td className="py-3 pr-4 text-muted">
                      {k.last_used_at ? new Date(k.last_used_at).toLocaleString() : "never"}
                    </td>
                    <td className="py-3 text-right">
                      <button
                        type="button"
                        title="Revoke key"
                        aria-label="Revoke key"
                        disabled={revoke.isPending}
                        onClick={() => revoke.mutate(k.id)}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden
                        >
                          <path d="M3 6h18" />
                          <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          <path d="M19 6 18 20a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                          <path d="M10 11v6M14 11v6" />
                        </svg>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Tile>
  );
}

function OrgGithubInstallCard() {
  const mint = useMintOrgGithubInstallUrl();
  const installs = useOrgGithubInstallations();
  const projectsQ = useOrgProjects();
  const projects = projectsQ.data?.projects ?? [];
  const installations = installs.data?.installations ?? [];

  return (
    <Tile label="GitHub at org level">
      <div className="space-y-3">
        <p className="text-[13px] text-muted">
          Install Superlog's GitHub App at your GitHub org or user level once, then grant its repos
          to any Superlog project below. Use this when one GitHub install needs to serve multiple
          Superlog projects — for a project-only install (no grants needed), use the per-project
          GitHub card in the <strong>Project</strong> tab.
        </p>
        <div className="flex items-center gap-2">
          {installations.length > 0 ? (
            <Chip tone="success" dot>
              {installations.length} {installations.length === 1 ? "install" : "installs"}
            </Chip>
          ) : (
            <Chip tone="muted" dot>
              No org-level install yet
            </Chip>
          )}
        </div>
        <div className="space-y-2">
          {mint.isError && (
            <p className="text-[12px] text-danger">
              Failed to generate install URL — please try again.
            </p>
          )}
          <Btn
            size="sm"
            variant={installations.length > 0 ? "secondary" : "primary"}
            loading={mint.isPending}
            disabled={mint.isPending}
            onClick={async () => {
              try {
                const res = await mint.mutateAsync();
                window.location.href = res.install_url;
              } catch {
                // surfaced via mint.isError above
              }
            }}
          >
            {installations.length > 0
              ? "Install on another GitHub org"
              : "Install GitHub App at org level"}
          </Btn>
        </div>
        {installations.length > 0 && (
          <div className="space-y-2 pt-2">
            <FieldLabel>Installs</FieldLabel>
            <div className="space-y-2">
              {installations.map((install) => (
                <OrgGithubInstallRow key={install.id} install={install} projects={projects} />
              ))}
            </div>
          </div>
        )}
      </div>
    </Tile>
  );
}

function OrgGithubInstallRow({
  install,
  projects,
}: {
  install: import("./api").OrgGithubInstallation;
  projects: import("./api").OrgProject[];
}) {
  const [expanded, setExpanded] = useState(false);
  const repos = useOrgGithubInstallRepos(expanded ? install.id : null);
  const grants = useOrgGithubInstallGrants(expanded ? install.id : null);
  const revokeInstall = useRevokeOrgGithubInstallation();
  const grantRepo = useGrantOrgRepoToProject();
  const revokeRepo = useRevokeOrgRepoFromProject();
  // Build a Map<repoId, Set<projectId>> from the grants response so each repo
  // row can answer "is repo R granted to project P?" in O(1).
  const grantsByRepo = useMemo(() => {
    const m = new Map<number, Set<string>>();
    for (const g of grants.data?.grants ?? []) {
      let set = m.get(g.repo_id);
      if (!set) {
        set = new Set();
        m.set(g.repo_id, set);
      }
      set.add(g.project_id);
    }
    return m;
  }, [grants.data?.grants]);

  const manageUrl =
    install.account_type === "Organization" && install.account_login
      ? `https://github.com/organizations/${install.account_login}/settings/installations/${install.installation_id}`
      : `https://github.com/settings/installations/${install.installation_id}`;

  return (
    <div className="space-y-2 border border-border px-2.5 py-2">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 items-center gap-2 text-left"
        >
          <span className="font-sans text-[10px] text-muted">{expanded ? "▾" : "▸"}</span>
          <div className="min-w-0">
            <div className="truncate text-[13px] text-fg">
              {install.account_login ?? `Installation ${install.installation_id}`}
            </div>
            <div className="font-sans text-[11px] text-muted">
              {install.account_type ?? "—"} · install {install.installation_id}
            </div>
          </div>
        </button>
        <div className="flex items-center gap-2">
          <Btn
            size="sm"
            variant="ghost"
            onClick={() => {
              window.location.href = manageUrl;
            }}
          >
            Manage on GitHub
          </Btn>
          <Btn
            size="sm"
            variant="ghost"
            loading={revokeInstall.isPending && revokeInstall.variables === install.id}
            onClick={() => {
              if (
                window.confirm(
                  `Revoke org-level GitHub install for ${install.account_login ?? install.installation_id}? Projects relying on its repo grants will lose access.`,
                )
              ) {
                revokeInstall.mutate(install.id);
              }
            }}
          >
            Revoke
          </Btn>
        </div>
      </div>
      {expanded && (
        <div className="space-y-2 border-t border-border pt-2">
          {repos.isLoading && <p className="text-[12px] text-muted">Loading repos from GitHub…</p>}
          {repos.isError && (
            <p className="text-[12px] text-danger">
              Failed to load repos — the install may have been uninstalled on GitHub.
            </p>
          )}
          {repos.data && repos.data.repos.length === 0 && (
            <p className="text-[12px] text-muted">
              The install covers no repositories yet. Visit GitHub to grant repo access, then
              refresh.
            </p>
          )}
          {repos.data && repos.data.repos.length > 0 && (
            <>
              {projects.length === 0 && (
                <p className="text-[12px] text-muted">No projects in this org to grant repos to.</p>
              )}
              <div className="max-h-72 space-y-1 overflow-y-auto">
                {repos.data.repos.map((repo) => {
                  const grantedTo = grantsByRepo.get(repo.id) ?? new Set<string>();
                  return (
                    <div
                      key={repo.id}
                      className="flex min-w-0 items-center justify-between gap-2 px-1 py-1"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-sans text-[11px] text-fg">
                          {repo.full_name}
                        </span>
                        <Chip tone={repo.private ? "muted" : "neutral"}>
                          {repo.private ? "private" : "public"}
                        </Chip>
                      </span>
                      <div className="flex flex-wrap items-center justify-end gap-1">
                        {projects.map((project) => {
                          const isGranted = grantedTo.has(project.id);
                          const pending =
                            (grantRepo.isPending &&
                              grantRepo.variables?.repoId === repo.id &&
                              grantRepo.variables?.projectId === project.id) ||
                            (revokeRepo.isPending &&
                              revokeRepo.variables?.repoId === repo.id &&
                              revokeRepo.variables?.projectId === project.id);
                          return (
                            <button
                              key={project.id}
                              type="button"
                              disabled={pending}
                              onClick={() => {
                                if (isGranted) {
                                  revokeRepo.mutate({
                                    projectId: project.id,
                                    installationRowId: install.id,
                                    repoId: repo.id,
                                  });
                                } else {
                                  grantRepo.mutate({
                                    projectId: project.id,
                                    installationRowId: install.id,
                                    repoId: repo.id,
                                  });
                                }
                              }}
                              className={
                                isGranted
                                  ? "inline-flex items-center gap-1 border border-accent bg-accent/15 px-1.5 py-0.5 font-sans text-[10px] text-accent"
                                  : "inline-flex items-center gap-1 border border-border px-1.5 py-0.5 font-sans text-[10px] text-muted hover:border-fg/40 hover:text-fg"
                              }
                              title={
                                isGranted
                                  ? `Revoke grant to ${project.name}`
                                  : `Grant to ${project.name}`
                              }
                            >
                              {isGranted ? "✓" : "+"} {project.slug}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
              {repos.data.truncated && (
                <p className="text-[11px] text-muted">
                  More than 1000 repos in this install — only the first 1000 are shown. Use the
                  management API to grant repos past this cap.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// The full webhook event catalog, mirrored from the backend
// WEBHOOK_EVENT_TYPES. Each entry is shown as a selectable subscription in the
// create form and the per-endpoint editor.
const WEBHOOK_EVENTS: ReadonlyArray<{ id: string; label: string }> = [
  {
    id: "incident.created",
    label: "A new incident is opened — post a new message / open a thread",
  },
  {
    id: "incident.updated",
    label:
      "Anything else happens on an incident — resolved, reopened, merged, or an investigation started / finished / failed / needs input. Reply in the thread. See change.kind.",
  },
];

const WEBHOOK_EVENT_IDS = WEBHOOK_EVENTS.map((e) => e.id);

function WebhookEventPicker({
  selected,
  onChange,
}: {
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const toggle = (id: string) => {
    onChange(selected.includes(id) ? selected.filter((e) => e !== id) : [...selected, id]);
  };
  return (
    <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
      {WEBHOOK_EVENTS.map((event) => (
        <label key={event.id} className="flex cursor-pointer items-start gap-2 text-[12px] text-fg">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={selected.includes(event.id)}
            onChange={() => toggle(event.id)}
          />
          <span>
            <code className="font-sans text-[11.5px] text-fg">{event.id}</code>
            <span className="block text-[11px] text-muted">{event.label}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

function WebhooksCard({ projectId }: { projectId: string | undefined }) {
  const list = useWebhooks(projectId);
  const create = useCreateWebhook(projectId ?? "");
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [events, setEvents] = useState<string[]>(WEBHOOK_EVENT_IDS);
  const [reveal, setReveal] = useState<{ id: string; secret: string } | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [schemaOpen, setSchemaOpen] = useState(false);

  const endpoints = list.data ?? [];

  return (
    <Tile>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-[12px] text-muted">
            Get an HTTP POST whenever an incident or investigation changes state — created,
            resolved, merged, and the full agent-run lifecycle. Pick which events each endpoint
            receives.
          </p>
          <button
            type="button"
            onClick={() => setSchemaOpen(true)}
            className="font-sans text-[11px] uppercase tracking-[0.2em] text-muted hover:text-fg"
          >
            view payloads
          </button>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[260px] flex-1">
            <FieldLabel>Endpoint URL</FieldLabel>
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/webhooks/superlog"
            />
          </div>
          <div className="min-w-[180px] flex-1">
            <FieldLabel>Description (optional)</FieldLabel>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="prod ingestor"
            />
          </div>
          <Btn
            size="md"
            variant="primary"
            disabled={!projectId || !url.trim() || events.length === 0 || create.isPending}
            loading={create.isPending}
            onClick={async () => {
              if (!projectId || !url.trim() || events.length === 0) return;
              try {
                const created = await create.mutateAsync({
                  url: url.trim(),
                  description: description.trim() || undefined,
                  enabledEvents: events,
                });
                if (created.secret) {
                  setReveal({ id: created.id, secret: created.secret });
                }
                setUrl("");
                setDescription("");
                setEvents(WEBHOOK_EVENT_IDS);
              } catch (err) {
                alert(err instanceof Error ? err.message : String(err));
              }
            }}
          >
            Add endpoint
          </Btn>
        </div>

        <div>
          <FieldLabel>Events</FieldLabel>
          <WebhookEventPicker selected={events} onChange={setEvents} />
        </div>

        {reveal && (
          <div className="rounded-sm border border-accent/40 bg-accent-soft/30 p-3">
            <div className="mb-1 flex items-center justify-between">
              <Label>Copy the signing secret — it will not be shown again</Label>
              <button
                onClick={() => setReveal(null)}
                className="text-[11px] text-muted hover:text-fg"
              >
                dismiss
              </button>
            </div>
            <code className="block break-all font-sans text-[12.5px] text-fg">{reveal.secret}</code>
          </div>
        )}

        <div className="border-t border-border">
          {list.isLoading ? (
            <div className="py-6 text-center text-[12px] text-muted">Loading…</div>
          ) : endpoints.length === 0 ? (
            <div className="py-6 text-center text-[12px] text-muted">
              No webhook endpoints configured for this project.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {endpoints.map((ep) => (
                <WebhookEndpointRow
                  key={ep.id}
                  endpoint={ep}
                  projectId={projectId ?? ""}
                  expanded={expandedId === ep.id}
                  onToggle={() => setExpandedId(expandedId === ep.id ? null : ep.id)}
                  onSecretRotated={(secret) => setReveal({ id: ep.id, secret })}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
      {schemaOpen && <WebhookSchemaModal onClose={() => setSchemaOpen(false)} />}
    </Tile>
  );
}

const INCIDENT_UPDATED_EXAMPLE = `{
  "event": "incident.updated",                      // the only update event
  "eventId": "5f0a6b6e-...",                       // UUID, unique per event
  "occurredAt": "2026-05-11T12:34:56.000Z",        // when we built the payload
  "project": { "id": "uuid", "name": "Default", "slug": "default" },
  "message": {                                      // render-ready text for relays (Telegram/email/SMS)
    "title": "TypeError in /api/orders",
    "body": "Investigation complete: missing null check. Opened PR: https://github.com/acme/orders/pull/4271"
  },
  "change": { "kind": "agent_completed" },          // what happened — drives how you render the reply
  "agentRun": {                                     // present for agent_* changes
    "id": "uuid",
    "state": "complete",
    "runtime": "anthropic",
    "completedAt": "2026-05-11T12:34:56.000Z",
    "startedAt": "2026-05-11T12:20:00.000Z",
    "cumulativeRuntimeMinutes": 14,
    "resumeCount": 0,
    "failureReason": null,
    "result": {
      // Shape is the agent's AgentRunResult. Treat unknown fields as additive.
      "state": "complete",
      "summary": "Root cause: missing null check in orders.ts:42",
      "rootCauseConfidence": "high",                // "high" | "medium" | "low" | null
      "rootCause": {                                // object, not a string
        "text": "orders.ts:42 dereferences \`customer\` without checking for null.",
        "confidence": 9                             // 0-10 scale
      },
      "estimatedImpact": {
        "text": "~3% of /api/orders requests since deploy at 11:14 UTC.",
        "confidence": 7
      },
      "severity": "SEV-2",                          // "SEV-1" | "SEV-2" | "SEV-3" | null
      "pr": {
        "selectedRepoFullName": "acme/orders",
        "branchName": "superlog/fix-orders-typeerror",
        "baseBranch": "main",
        "openStatus": "opened",
        "url": "https://github.com/acme/orders/pull/4271",
        "patch": "diff --git a/orders.ts b/orders.ts\\n...",
        "validationPassed": true
      },
      "linearTicket": {
        "id": "...",
        "url": "https://linear.app/acme/issue/ENG-1234",
        "createdByAgent": true
      },
      "noiseClassification": null,                  // set instead of pr/linearTicket if classified noise
      "resolutionClassification": null              // set if the issue was already fixed in current code
    }
  },
  "incident": {
    "id": "uuid",
    "title": "TypeError in /api/orders",
    "codename": "squishy-narwhal",
    "status": "open",                               // "open" | "resolved" | "autoresolved_noise" | "merged"
    "severity": "SEV-2",                            // "SEV-1" | "SEV-2" | "SEV-3" | null
    "service": "orders",
    "firstSeen": "2026-05-11T11:00:00.000Z",
    "lastSeen": "2026-05-11T12:30:00.000Z",
    "issueCount": 14
  },
  "events": [                                       // chronological audit log for the agent run
    {
      "id": "uuid",
      "kind": "agent_run_started",
      "summary": "...",
      "detail": {},                                 // free-form, kind-specific
      "createdAt": "2026-05-11T12:20:00.000Z"
    }
  ],
  "pullRequests": [                                 // empty array if no PR was opened
    {
      "id": "uuid",
      "repoFullName": "acme/orders",
      "prNumber": 4271,
      "url": "https://github.com/acme/orders/pull/4271",
      "branchName": "superlog/fix-orders-typeerror",
      "baseBranch": "main",
      "state": "open",                              // "open" | "closed" | "merged"
      "title": "[superlog] Fix TypeError in /api/orders",
      "mergedAt": null,
      "closedAt": null
    }
  ],
  "linearTickets": [                                // empty array if Linear isn't connected / no ticket
    {
      "id": "uuid",
      "workspaceId": "...",
      "ticketId": "...",
      "ticketIdentifier": "ENG-1234",
      "url": "https://linear.app/acme/issue/ENG-1234",
      "title": "Fix TypeError in /api/orders",
      "state": "In Progress"
    }
  ]
}`;

const IMPLEMENT_PROMPT = `I want to add a Superlog webhook receiver to my app. Superlog sends just two events:
- \`incident.created\` — a new incident opened. Relay it as a NEW message / open a new thread.
- \`incident.updated\` — anything else happened on an incident. Relay it as a REPLY in that thread (or edit). Look at \`change.kind\` to decide what to say.

Both payloads carry a render-ready \`message: { title, body }\` so a simple relay can forward text without understanding the rest of the schema, plus structured \`incident\` / \`agentRun\` / \`change\` for richer handling.

Endpoint requirements:
- Accept POST at a route I choose (e.g. /webhooks/superlog). Read the **raw** request body before any JSON parsing — the signature is computed over the raw bytes.
- Headers to handle:
  - \`Superlog-Signature\`: \`t=<unix-ts>,v1=<hex-hmac-sha256>\`. Verify with \`HMAC_SHA256(secret, "<t>.<rawBody>")\` and compare in constant time. Reject if \`|now - t| > 300\` seconds.
  - \`Superlog-Event\`: \`incident.created\` or \`incident.updated\`.
  - \`Superlog-Delivery\`: a UUID that is **stable across retries**. Use it as an idempotency key — if you've already processed it, return 200 without re-running side effects.
- The signing secret comes from env var \`SUPERLOG_WEBHOOK_SECRET\` (starts with \`whsec_\`).
- Respond 2xx within 10 seconds. Do any slow work (DB writes, downstream calls) async / after the response. Non-2xx and timeouts are retried with backoff before attempts 2-8: 30s, 1m, 2m, 5m, 15m, 1h, 6h. After 8 failed attempts the sender gives up.
- On signature failure return 401. On replay (already-seen delivery id) return 200.

Payload shape:
\`\`\`json
{
  "event": "incident.updated",                 // or "incident.created"
  "eventId": "uuid",
  "occurredAt": "ISO-8601",
  "project": { "id": "uuid", "name": "...", "slug": "..." },
  "message": { "title": "...", "body": "..." },  // render-ready; forward verbatim if you want
  "incident": {
    "id": "uuid", "title": "...", "codename": "...",
    "status": "open",                            // "open" | "resolved" | "autoresolved_noise" | "merged"
    "severity": "SEV-2",                         // "SEV-1" | "SEV-2" | "SEV-3" | null
    "service": "...",
    "firstSeen": "ISO-8601", "lastSeen": "ISO-8601", "issueCount": 14
  },
  // --- only on incident.updated ---
  "change": { "kind": "agent_completed" },       // resolved | reopened | merged | agent_started |
                                                 //   agent_completed | agent_failed | agent_awaiting_input
  "agentRun": { "id": "uuid", "state": "complete", "result": { /* AgentRunResult */ } }, // agent_* changes
  "events": [ { "id": "uuid", "kind": "...", "summary": "...", "detail": {}, "createdAt": "ISO-8601" } ], // agent_completed
  "pullRequests": [ { "id": "uuid", "repoFullName": "owner/repo", "prNumber": 1, "url": "...", "state": "open" } ], // agent_completed
  "linearTickets": [ { "id": "uuid", "ticketIdentifier": "ENG-1", "url": "...", "state": "..." } ] // agent_completed
}
\`\`\`

Notes:
- \`change.kind\` discriminates the update. For \`resolved\` it adds a \`resolution\` object; \`reopened\` adds \`reason\`/\`previousStatus\`; \`merged\` adds \`mergedInto\`/\`evidence\`; \`agent_awaiting_input\` adds \`reason\`/\`summary\`/\`question\`.
- \`agentRun\`, \`events\`, \`pullRequests\`, \`linearTickets\` only appear on agent-related updates (\`events\`/\`pullRequests\`/\`linearTickets\` only on \`agent_completed\`).
- Unknown future fields may appear — treat additively.

What to build:
1. The route handler with raw-body access and signature verification.
2. An idempotency store keyed on \`Superlog-Delivery\` (use whatever the codebase already uses — Redis, Postgres, in-memory for dev).
3. A typed payload + a stub handler that switches on \`event\` and \`change.kind\`. For now, just relay \`message.title\` / \`message.body\` to the destination (log it).
4. A unit test that posts a valid signed request and a tampered request, asserting 200 and 401 respectively.

Match the framework, language, and conventions already in this repo. Don't add new dependencies if the standard library covers it (\`crypto\` / \`hmac\` is enough for verification).`;

const VERIFY_SNIPPET = `import { createHmac, timingSafeEqual } from "node:crypto";

function verify(secret: string, header: string, rawBody: string): boolean {
  const parts = Object.fromEntries(
    header.split(",").map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i), p.slice(i + 1)];
    }),
  );
  const ts = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(ts) || !v1) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > 300) return false;
  const expected = createHmac("sha256", secret)
    .update(\`\${ts}.\${rawBody}\`)
    .digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(v1);
  return a.length === b.length && timingSafeEqual(a, b);
}`;

function WebhookSchemaModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-bg/70 px-4 py-12 backdrop-blur-md"
      onClick={onClose}
    >
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-3xl">
        <Tile className="bg-bg shadow-2xl">
          <div className="mb-5 flex items-center justify-between">
            <div>
              <Label>webhook payloads</Label>
              <div className="mt-1 text-[16px] font-medium text-fg">Event reference</div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="font-sans text-[11px] uppercase tracking-[0.2em] text-subtle hover:text-fg"
            >
              close
            </button>
          </div>

          <div className="space-y-5">
            <section>
              <h3 className="mb-2 text-[13px] font-medium text-fg">Events</h3>
              <p className="mb-2 text-[12px] text-muted">
                Think of a webhook as a message to relay. <code>incident.created</code> means "post
                a new message / open a thread"; <code>incident.updated</code> means "reply in that
                thread / edit it". Every payload shares the envelope{" "}
                <code>{`{ event, eventId, occurredAt, project, incident, message }`}</code> — where{" "}
                <code>message</code> is render-ready <code>{`{ title, body }`}</code> text. Updates
                add a <code>change.kind</code> (and an <code>agentRun</code> for investigation
                changes); the example below shows the richest one.
              </p>
              <ul className="divide-y divide-border rounded-sm border border-border">
                {WEBHOOK_EVENTS.map((event) => (
                  <li
                    key={event.id}
                    className="flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:items-baseline sm:gap-3"
                  >
                    <code className="font-sans text-[12px] text-fg sm:w-[200px] sm:shrink-0">
                      {event.id}
                    </code>
                    <span className="text-[12px] text-muted">{event.label}</span>
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <h3 className="mb-2 text-[13px] font-medium text-fg">Headers</h3>
              <div className="rounded-sm border border-border bg-surface-2 p-3 font-sans text-[12px]">
                <div>
                  <span className="text-muted">Content-Type:</span> application/json
                </div>
                <div>
                  <span className="text-muted">Superlog-Event:</span> incident.updated
                </div>
                <div>
                  <span className="text-muted">Superlog-Delivery:</span> &lt;uuid, stable across
                  retries&gt;
                </div>
                <div>
                  <span className="text-muted">Superlog-Signature:</span>{" "}
                  t=&lt;unix-ts&gt;,v1=&lt;hex-hmac&gt;
                </div>
              </div>
            </section>

            <section>
              <h3 className="mb-2 text-[13px] font-medium text-fg">Example body</h3>
              <pre className="max-h-[400px] overflow-auto rounded-sm border border-border bg-surface-2 p-3 font-sans text-[11.5px] leading-[1.55] text-fg">
                {INCIDENT_UPDATED_EXAMPLE}
              </pre>
            </section>

            <section>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-[13px] font-medium text-fg">
                  Prompt to hand to your coding agent
                </h3>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard?.writeText(IMPLEMENT_PROMPT).catch(() => {});
                  }}
                  className="font-sans text-[11px] uppercase tracking-[0.2em] text-muted hover:text-fg"
                >
                  copy
                </button>
              </div>
              <p className="mb-2 text-[12px] text-muted">
                Paste this into Claude Code / Cursor / your IDE agent. It describes the headers,
                signature scheme, payload, and what to build.
              </p>
              <pre className="max-h-[260px] overflow-auto rounded-sm border border-border bg-surface-2 p-3 font-sans text-[11.5px] leading-[1.55] text-fg whitespace-pre-wrap">
                {IMPLEMENT_PROMPT}
              </pre>
            </section>

            <section>
              <h3 className="mb-2 text-[13px] font-medium text-fg">Verify the signature</h3>
              <p className="mb-2 text-[12px] text-muted">
                Compute HMAC-SHA256 over <code>{`<timestamp>.<rawBody>`}</code> using your
                endpoint's signing secret and compare against the <code>v1</code> value. Verify
                against the raw body, before JSON-parsing.
              </p>
              <pre className="max-h-[260px] overflow-auto rounded-sm border border-border bg-surface-2 p-3 font-sans text-[11.5px] leading-[1.55] text-fg">
                {VERIFY_SNIPPET}
              </pre>
            </section>

            <section>
              <h3 className="mb-2 text-[13px] font-medium text-fg">Delivery</h3>
              <ul className="list-disc space-y-1 pl-5 text-[12px] text-muted">
                <li>
                  <code>POST</code> with <code>Content-Type: application/json</code>. Respond 2xx
                  within 10 seconds.
                </li>
                <li>
                  Non-2xx responses and connection errors / timeouts are retried with backoff before
                  attempts 2-8: 30s → 1m → 2m → 5m → 15m → 1h → 6h. After 8 failed attempts (~8h
                  total) the delivery is marked <code>failed</code>.
                </li>
                <li>
                  Automatic retries reuse the same <code>Superlog-Delivery</code> id — de-dupe on
                  it. A manual <em>redeliver</em> from this page enqueues a new delivery with a new
                  id.
                </li>
                <li>
                  Receiver advice: verify the signature on the raw body and reject if the timestamp
                  drifts &gt; 5 minutes from your clock.
                </li>
                <li>
                  The <strong>Send test</strong> button posts a stub payload (
                  <code>{`{ event, eventId, occurredAt, test: true, message, project }`}</code>) —
                  not a full agent run snapshot. Use it to check transport + signature only.
                </li>
                <li>
                  Disabling an endpoint stops new deliveries. Any deliveries still pending when the
                  endpoint is disabled are marked <code>failed</code> with{" "}
                  <code>lastError = "endpoint disabled"</code>.
                </li>
                <li>
                  Deliveries record only the outcome (status + HTTP response code). Destinations
                  must be public http(s) endpoints — private, loopback, and link-local addresses are
                  rejected — and the upstream response body is never stored or shown.
                </li>
              </ul>
            </section>
          </div>
        </Tile>
      </div>
    </div>
  );
}

function WebhookEndpointRow({
  endpoint,
  projectId,
  expanded,
  onToggle,
  onSecretRotated,
}: {
  endpoint: WebhookEndpoint;
  projectId: string;
  expanded: boolean;
  onToggle: () => void;
  onSecretRotated: (secret: string) => void;
}) {
  const test = useTestWebhook(projectId);
  const update = useUpdateWebhook(projectId);
  const del = useDeleteWebhook(projectId);
  const rotate = useRotateWebhookSecret(projectId);
  const disabled = !!endpoint.disabledAt;
  const serverEvents = endpoint.enabledEvents ?? [];
  const serverEventsKey = serverEvents.join("\u0000");
  const [draftEvents, setDraftEvents] = useState<string[]>(serverEvents);
  // Re-sync the local draft whenever the server value actually changes (after a
  // save, or a background refetch / concurrent edit), so the picker can't show
  // stale selections and "Save events" can't clobber newer server state. We key
  // off a serialized signature and only reset on change, so the initial render
  // and unrelated re-renders leave an in-progress edit untouched.
  const lastSyncedRef = useRef(serverEventsKey);
  useEffect(() => {
    if (lastSyncedRef.current !== serverEventsKey) {
      lastSyncedRef.current = serverEventsKey;
      setDraftEvents(serverEvents);
    }
  }, [serverEventsKey, serverEvents]);
  const eventsDirty =
    draftEvents.length !== serverEvents.length ||
    draftEvents.some((e) => !serverEvents.includes(e));

  return (
    <li className="py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={onToggle}
            className="block w-full truncate text-left font-sans text-[12.5px] text-fg hover:underline"
          >
            {endpoint.url}
          </button>
          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted">
            {endpoint.description && <span>{endpoint.description}</span>}
            <Chip tone={disabled ? "warning" : "success"} dot>
              {disabled ? "disabled" : "active"}
            </Chip>
            <span>{(endpoint.enabledEvents ?? []).join(", ")}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Btn
            size="sm"
            variant="ghost"
            onClick={() => test.mutate(endpoint.id)}
            loading={test.isPending}
          >
            Send test
          </Btn>
          <Btn
            size="sm"
            variant="ghost"
            onClick={() => update.mutate({ id: endpoint.id, disabled: !disabled })}
          >
            {disabled ? "Enable" : "Disable"}
          </Btn>
          <Btn
            size="sm"
            variant="ghost"
            onClick={async () => {
              if (!confirm("Rotate signing secret? The current secret will stop working.")) return;
              const out = await rotate.mutateAsync(endpoint.id);
              onSecretRotated(out.secret);
            }}
          >
            Rotate
          </Btn>
          <Btn
            size="sm"
            variant="ghost"
            onClick={() => {
              if (!confirm("Delete this webhook endpoint?")) return;
              del.mutate(endpoint.id);
            }}
          >
            Delete
          </Btn>
        </div>
      </div>
      {expanded && (
        <>
          <div className="mt-3 rounded-sm border border-border bg-surface-2 p-3">
            <div className="mb-2 flex items-center justify-between">
              <Label>Subscribed events</Label>
              <Btn
                size="sm"
                variant="ghost"
                disabled={!eventsDirty || draftEvents.length === 0 || update.isPending}
                loading={update.isPending}
                onClick={async () => {
                  try {
                    await update.mutateAsync({ id: endpoint.id, enabledEvents: draftEvents });
                  } catch (err) {
                    alert(err instanceof Error ? err.message : String(err));
                  }
                }}
              >
                Save events
              </Btn>
            </div>
            <WebhookEventPicker selected={draftEvents} onChange={setDraftEvents} />
          </div>
          <WebhookDeliveriesPanel projectId={projectId} endpointId={endpoint.id} />
        </>
      )}
    </li>
  );
}

function WebhookDeliveriesPanel({
  projectId,
  endpointId,
}: {
  projectId: string;
  endpointId: string;
}) {
  const deliveries = useWebhookDeliveries(projectId, endpointId);
  const redeliver = useRedeliverWebhook(projectId, endpointId);
  const rows = deliveries.data ?? [];

  return (
    <div className="mt-3 rounded-sm border border-border bg-surface-2 p-3">
      <div className="mb-2 flex items-center justify-between">
        <Label>Recent deliveries</Label>
        <span className="text-[11px] text-muted">auto-refreshing</span>
      </div>
      {deliveries.isLoading ? (
        <div className="py-4 text-center text-[12px] text-muted">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="py-4 text-center text-[12px] text-muted">No deliveries yet.</div>
      ) : (
        <table className="w-full text-[12px]">
          <thead>
            <tr className="border-b border-border text-left text-muted">
              <th className="py-1 pr-3 font-sans text-[10px] uppercase tracking-[0.2em]">When</th>
              <th className="py-1 pr-3 font-sans text-[10px] uppercase tracking-[0.2em]">Event</th>
              <th className="py-1 pr-3 font-sans text-[10px] uppercase tracking-[0.2em]">Status</th>
              <th className="py-1 pr-3 font-sans text-[10px] uppercase tracking-[0.2em]">
                Attempts
              </th>
              <th className="py-1 pr-3 font-sans text-[10px] uppercase tracking-[0.2em]">HTTP</th>
              <th className="py-1 font-sans text-[10px] uppercase tracking-[0.2em]" />
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <DeliveryRow key={d.id} delivery={d} onRedeliver={() => redeliver.mutate(d.id)} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function DeliveryRow({
  delivery,
  onRedeliver,
}: {
  delivery: WebhookDelivery;
  onRedeliver: () => void;
}) {
  const [open, setOpen] = useState(false);
  const tone =
    delivery.status === "success" ? "success" : delivery.status === "failed" ? "danger" : "warning";
  return (
    <>
      <tr className="border-b border-border last:border-0">
        <td className="py-1.5 pr-3 text-muted">{new Date(delivery.createdAt).toLocaleString()}</td>
        <td className="py-1.5 pr-3 font-sans">{delivery.eventType}</td>
        <td className="py-1.5 pr-3">
          <Chip tone={tone} dot>
            {delivery.status}
          </Chip>
        </td>
        <td className="py-1.5 pr-3 tabular-nums">{delivery.attemptCount}</td>
        <td className="py-1.5 pr-3 tabular-nums text-muted">
          {delivery.lastResponseStatus ?? "—"}
        </td>
        <td className="py-1.5 text-right">
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="mr-2 text-[11px] text-muted hover:text-fg"
          >
            {open ? "hide" : "details"}
          </button>
          <button
            type="button"
            onClick={onRedeliver}
            className="text-[11px] text-muted hover:text-fg"
          >
            redeliver
          </button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={6} className="bg-surface-1 py-2 pr-3">
            <div className="space-y-1 font-sans text-[11px] text-muted">
              <div>next attempt: {new Date(delivery.nextAttemptAt).toLocaleString()}</div>
              {delivery.deliveredAt && (
                <div>delivered: {new Date(delivery.deliveredAt).toLocaleString()}</div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
