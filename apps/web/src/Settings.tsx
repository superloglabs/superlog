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
  type LinearTicketPolicy,
  type PrPolicy,
  type RepoBranch,
  type WebhookDelivery,
  type WebhookEndpoint,
  useAgentSettings,
  useCloudConnections,
  useCreateCloudConnection,
  useCreateKey,
  useCreateOrgProject,
  useCreateWebhook,
  useDeleteCloudConnection,
  useDeleteOrgProject,
  useDeleteSlackRoute,
  useDeleteWebhook,
  useGithubBranches,
  useGithubInstallation,
  useGrantOrgRepoToProject,
  useIntegrations,
  useIssueFilterAttributeKeys,
  useIssueFilterAttributeValues,
  useIssueFilterPreview,
  useKeys,
  useLinearInstallation,
  useMe,
  useMintOrgApiKey,
  useMintOrgGithubInstallUrl,
  useOrgAgentSettings,
  useOrgApiKeys,
  useOrgDigest,
  useOrgGithubInstallGrants,
  useOrgGithubInstallRepos,
  useOrgGithubInstallations,
  useOrgProjects,
  useRedeliverWebhook,
  useRemoveIntegration,
  useResetGithubCommitAuthor,
  useRevokeKey,
  useRevokeOrgApiKey,
  useRevokeOrgGithubInstallation,
  useRevokeOrgRepoFromProject,
  useRotateWebhookSecret,
  useRunOrgDigestNow,
  useSaveAgentSettings,
  useSaveIntegration,
  useSaveOrgAgentSettings,
  useSaveOrgDigest,
  useSetSlackRoute,
  useSlackChannels,
  useSlackInstallation,
  useSlackRoute,
  useStartGithubAccessLogin,
  useStartGithubAuthorLogin,
  useStartGithubInstall,
  useStartLinearInstall,
  useStartSlackInstall,
  useTestWebhook,
  useUninstallLinear,
  useUninstallSlack,
  useUpdateGithubRepoAccess,
  useUpdateOrgProject,
  useUpdateWebhook,
  useVerifyCloudConnection,
  useWebhookDeliveries,
  useWebhooks,
} from "./api";
import { Dropdown, type DropdownOption } from "./design/Dropdown.tsx";
import { Btn, Chip, FieldLabel, Input, Label, Tile } from "./design/ui";
import { describeIntegrationConnectError } from "./integrationError.ts";
import { AgentMemoriesCard } from "./settings/AgentMemoriesCard.tsx";
import { BillingCard } from "./settings/BillingCard.tsx";
import { OrgGeneralCard } from "./settings/OrgGeneralCard.tsx";
import { OrgMembersCard } from "./settings/OrgMembersCard.tsx";
import {
  ORG_NAV_GROUPS,
  type OrgSectionId,
  PROJECT_NAV_GROUPS,
  type ProjectSectionId,
  type SectionId,
  type SettingsScope,
  NEW_PROJECT_OPTION_VALUE,
  nextProjectIdAfterDelete,
  projectPickerOptions,
  resolveOrgSection,
  resolveProjectSection,
  shouldShowProjectPicker,
} from "./settings/nav.ts";
import { SettingsCard, SettingsCardFooter, SettingsRow } from "./settings/rows.tsx";

type NavTarget = {
  scope?: SettingsScope;
  projectId?: string | null;
  section?: SectionId;
};

export function Settings() {
  const [params, setParams] = useSearchParams();
  const linearStatus = params.get("linear");
  const githubStatus = params.get("github");
  const githubAuthorStatus = params.get("github_author");

  useEffect(() => {
    if (!linearStatus && !githubStatus && !githubAuthorStatus) return;
    const t = setTimeout(() => {
      params.delete("linear");
      params.delete("github");
      params.delete("github_author");
      setParams(params, { replace: true });
    }, 4000);
    return () => clearTimeout(t);
  }, [linearStatus, githubStatus, githubAuthorStatus, params, setParams]);

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
      {(linearStatus || githubStatus || githubAuthorStatus) && (
        <header className="space-y-2">
          {linearStatus && <LinearStatusBanner status={linearStatus} />}
          {githubStatus && <GithubStatusBanner status={githubStatus} />}
          {githubAuthorStatus && <GithubAuthorStatusBanner status={githubAuthorStatus} />}
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
                navigate({ scope: "project", projectId: nextProjectId ?? null, section: "general" });
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
  const groups = scope === "org" ? ORG_NAV_GROUPS : PROJECT_NAV_GROUPS;
  return (
    <nav className="shrink-0 md:sticky md:top-6 md:w-56">
      <ul className="flex flex-col gap-0.5">
        {groups.map((group, gi) => (
          <li key={group.label ?? gi}>
            {group.label && (
              <p className="mb-1 mt-4 px-3 text-[11px] uppercase tracking-wider text-muted">
                {group.label}
              </p>
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
  const key = `${scope}:${section}`;
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
    case "org:agent-guidance":
    case "project:agent":
      return (
        <svg {...props} aria-hidden="true">
          <path d="M12 3a7 7 0 0 1 7 7v3a7 7 0 0 1-14 0v-3a7 7 0 0 1 7-7z" />
          <circle cx="9" cy="12" r="0.5" fill="currentColor" />
          <circle cx="15" cy="12" r="0.5" fill="currentColor" />
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
            title="Weekly fixes digest"
            subtitle="A short Slack recap of the top 3 pending bug-fix PRs, ranked by an LLM."
          >
            <WeeklyDigestCard />
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
        <Section title="Integrations" subtitle="Per-project connections.">
          <div className="flex flex-col gap-4">
            <GithubCard />
            <SlackCard />
            <LinearCard />
            <AwsCard projectId={projectId} />
          </div>
        </Section>
      );
    case "agent":
      return (
        <Section
          title="Bug-investigating agent"
          subtitle="The flow each incident runs through. Toggle steps and configure their policies."
        >
          <AgentFlowchart projectId={projectId} />
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
    case "issue-filter":
      return (
        <Section
          title="Issue filter"
          subtitle="Drop error logs and traces whose attributes don't match before they create issues."
        >
          <IssueFilterCard projectId={projectId} />
        </Section>
      );
    case "slack-channel":
      return (
        <Section
          title="Slack channel"
          subtitle="Where this project's incident threads are posted. Disable to stop posting entirely."
        >
          <SlackRoutingCard projectId={projectId} />
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
              <Input className="font-mono text-[12.5px]" value={project?.slug ?? ""} disabled />
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
            className="w-full rounded-lg border border-border bg-surface-2 p-3 font-mono text-[12.5px] text-fg placeholder:text-subtle focus:border-border-strong focus:outline-none disabled:opacity-60"
          />
          <div className="mt-1 flex justify-end font-mono text-[12px] tabular-nums text-muted">
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
      <div>
        <h2 className="text-[15px] font-medium">{title}</h2>
        <p className="text-[13px] text-muted">{subtitle}</p>
      </div>
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

function GithubCard() {
  const [params] = useSearchParams();
  const install = useGithubInstallation();
  const start = useStartGithubInstall();
  const startAccess = useStartGithubAccessLogin();
  const startAuthor = useStartGithubAuthorLogin();
  const resetAuthor = useResetGithubCommitAuthor();
  const updateRepoAccess = useUpdateGithubRepoAccess();
  const [connectError, setConnectError] = useState<string | null>(null);

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
    <Tile label="GitHub">
      <div className="space-y-3">
        <p className="text-[13px] text-muted">
          Required for opening pull requests. Connect GitHub to find existing app installs or add
          repo access.
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
            onClick={() => {
              setConnectError(null);
              startAccess.mutate(undefined, {
                onSuccess: ({ url }) => {
                  window.location.href = url;
                },
                onError: (err) => setConnectError(describeIntegrationConnectError(err, "GitHub")),
              });
            }}
          >
            {installed ? "Refresh access" : "Connect GitHub"}
          </Btn>
          <Btn
            size="sm"
            variant={needsInstall ? "primary" : "secondary"}
            loading={start.isPending}
            onClick={() => {
              setConnectError(null);
              start.mutate(undefined, {
                onSuccess: ({ url }) => {
                  window.location.href = url;
                },
                onError: (err) => setConnectError(describeIntegrationConnectError(err, "GitHub")),
              });
            }}
          >
            {installed ? "Add repositories" : "Install GitHub App"}
          </Btn>
        </div>
        {connectError && (
          <p className="text-[12px] text-danger" role="alert">
            {connectError}
          </p>
        )}
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
                          {installation.accountLogin ??
                            `Installation ${installation.installationId}`}
                        </div>
                        <div className="font-mono text-[11px] text-muted">
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
                            <span className="truncate font-mono text-[11px] text-fg">
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
                <div className="flex h-6 w-6 flex-none items-center justify-center rounded-sm border border-border font-mono text-[10px] text-muted">
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
                <div className="truncate font-mono text-[11px] text-muted">
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
    </Tile>
  );
}

function SlackCard() {
  const install = useSlackInstallation();
  const start = useStartSlackInstall();
  const uninstall = useUninstallSlack();

  const installed = install.data?.installed === true;

  return (
    <Tile label="Slack">
      <div className="space-y-3">
        <p className="text-[13px] text-muted">
          Posts incident threads and routes the agent's questions back to humans. Pick the channel
          (or disable posting) per project below.
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
              loading={uninstall.isPending}
              onClick={() => uninstall.mutate()}
            >
              Disconnect
            </Btn>
          )}
        </div>
      </div>
    </Tile>
  );
}

function SlackRoutingCard({ projectId }: { projectId: string | undefined }) {
  const install = useSlackInstallation();
  const installed = install.data?.installed === true;
  const route = useSlackRoute(projectId);
  const channels = useSlackChannels(installed && !!projectId);
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

function WeeklyDigestCard() {
  const install = useSlackInstallation();
  const installed = install.data?.installed === true;
  const digest = useOrgDigest();
  const channels = useSlackChannels(installed);
  const save = useSaveOrgDigest();
  const runNow = useRunOrgDigestNow();

  const enabled = digest.data?.enabled ?? false;
  const channelId = digest.data?.channelId ?? "";
  const channelName = digest.data?.channelName ?? null;
  const lastRunAt = digest.data?.lastRunAt;
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
        title="Post a weekly recap to Slack"
        description={
          enabled && channelId
            ? `Posting to #${channelName ?? channelId} · ${lastRunLabel}`
            : lastRunLabel
        }
        control={
          <Toggle
            checked={enabled}
            disabled={save.isPending || (!enabled && !channelId)}
            onChange={(v) => save.mutate({ enabled: v })}
          />
        }
      />
      <SettingsRow
        title="Channel"
        description="Use a different channel from incident threads if it's noisy — invite the bot to private channels"
        control={
          <div className="w-60">
            <Dropdown
              value={channelId}
              disabled={channels.isLoading || channels.isError || save.isPending}
              onChange={(next) => {
                if (!next) {
                  save.mutate({ enabled: false, channelId: null, channelName: null });
                  return;
                }
                const ch = channelList.find((c) => c.id === next);
                save.mutate({ channelId: next, channelName: ch?.name ?? null });
              }}
              placeholder={
                channels.isLoading
                  ? "Loading channels…"
                  : channels.isError
                    ? "Failed to load channels"
                    : "No channel"
              }
              emptyLabel="No channels found"
              options={[
                { value: "", searchText: "No channel", label: "No channel" },
                ...channelList.map((ch) => ({
                  value: ch.id,
                  searchText: `${ch.isPrivate ? "🔒 " : "#"}${ch.name}`,
                  label: (
                    <span className="flex items-center gap-1.5">
                      <span className="text-subtle">{ch.isPrivate ? "🔒" : "#"}</span>
                      <span>{ch.name}</span>
                    </span>
                  ),
                })),
              ]}
            />
          </div>
        }
      />
      <SettingsRow
        title="Send digest now"
        description="An LLM ranks the open bug-fix PRs across this org and posts the top 3"
        control={
          <Btn
            size="sm"
            variant="secondary"
            disabled={!channelId || runNow.isPending}
            loading={runNow.isPending}
            onClick={() => runNow.mutate()}
          >
            Send now
          </Btn>
        }
      />
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
    <Tile label="Linear">
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
    </Tile>
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
const AWS_REGIONS: ReadonlyArray<{ code: string; name: string }> = [
  { code: "us-east-1", name: "US East (N. Virginia)" },
  { code: "us-east-2", name: "US East (Ohio)" },
  { code: "us-west-1", name: "US West (N. California)" },
  { code: "us-west-2", name: "US West (Oregon)" },
  { code: "ca-central-1", name: "Canada (Central)" },
  { code: "ca-west-1", name: "Canada West (Calgary)" },
  { code: "eu-west-1", name: "Europe (Ireland)" },
  { code: "eu-west-2", name: "Europe (London)" },
  { code: "eu-west-3", name: "Europe (Paris)" },
  { code: "eu-central-1", name: "Europe (Frankfurt)" },
  { code: "eu-central-2", name: "Europe (Zurich)" },
  { code: "eu-north-1", name: "Europe (Stockholm)" },
  { code: "eu-south-1", name: "Europe (Milan)" },
  { code: "eu-south-2", name: "Europe (Spain)" },
  { code: "ap-south-1", name: "Asia Pacific (Mumbai)" },
  { code: "ap-south-2", name: "Asia Pacific (Hyderabad)" },
  { code: "ap-southeast-1", name: "Asia Pacific (Singapore)" },
  { code: "ap-southeast-2", name: "Asia Pacific (Sydney)" },
  { code: "ap-southeast-3", name: "Asia Pacific (Jakarta)" },
  { code: "ap-southeast-4", name: "Asia Pacific (Melbourne)" },
  { code: "ap-southeast-5", name: "Asia Pacific (Malaysia)" },
  { code: "ap-southeast-7", name: "Asia Pacific (Thailand)" },
  { code: "ap-northeast-1", name: "Asia Pacific (Tokyo)" },
  { code: "ap-northeast-2", name: "Asia Pacific (Seoul)" },
  { code: "ap-northeast-3", name: "Asia Pacific (Osaka)" },
  { code: "ap-east-1", name: "Asia Pacific (Hong Kong)" },
  { code: "ap-east-2", name: "Asia Pacific (Taipei)" },
  { code: "sa-east-1", name: "South America (São Paulo)" },
  { code: "mx-central-1", name: "Mexico (Central)" },
  { code: "me-south-1", name: "Middle East (Bahrain)" },
  { code: "me-central-1", name: "Middle East (UAE)" },
  { code: "il-central-1", name: "Israel (Tel Aviv)" },
  { code: "af-south-1", name: "Africa (Cape Town)" },
];

const AWS_REGION_OPTIONS = AWS_REGIONS.map((r) => ({
  value: r.code,
  label: (
    <span>
      <span className="font-mono">{r.code}</span>
      <span className="text-muted"> · {r.name}</span>
    </span>
  ),
  searchText: `${r.code} ${r.name}`,
}));

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
    <Tile label="AWS">
      <div className="space-y-3">
        <p className="text-[13px] text-muted">
          Connect your AWS account to inventory resources and stream CloudWatch metrics. Deploys a
          read-only IAM role you control via CloudFormation — revoke any time.
        </p>

        <div>{awsStatusChip(active)}</div>

        {active?.status === "connected" ? (
          <div className="flex items-center gap-2">
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
    </Tile>
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
          className="w-full rounded-lg border border-border bg-surface-2 p-3 font-mono text-[12.5px] text-fg placeholder:text-subtle focus:border-border-strong focus:outline-none disabled:opacity-60"
        />
        <div className="flex items-center justify-between text-[12px] text-muted">
          <span>Prepended to every agent run prompt across all projects in this org.</span>
          <span className="font-mono tabular-nums">
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
          </div>
        </FlowNode>

        <FlowConnector active={downstreamEligible && data.linearTicketPolicy !== "never"} />

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
            ) : data.linearTicketPolicy === "never" ? (
              <Chip tone="muted" dot>
                Off
              </Chip>
            ) : data.linearTicketPolicy === "always" ? (
              <Chip tone="success" dot>
                Every incident
              </Chip>
            ) : (
              <Chip tone="success" dot>
                On identified fix
              </Chip>
            )
          }
          spineActive={downstreamEligible && linearConnected && data.linearTicketPolicy !== "never"}
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
              <PolicyControls
                value={data.linearTicketPolicy}
                disabled={!downstreamEligible || save.isPending}
                onChange={(v) => patch({ linearTicketPolicy: v as LinearTicketPolicy })}
                labels={{
                  on_ready_to_pr: "Only when the fix is identifiable",
                  always: "Every incident",
                  never: "Never",
                }}
                hints={{
                  on_ready_to_pr:
                    "The agent files a ticket only after pinpointing a concrete fix or root cause.",
                  always:
                    "The agent ensures every incident has a Linear ticket — useful for audit trails.",
                  never:
                    "Linear stays connected, but the agent will not touch it during agent_runs.",
                }}
              />
              {data.linearTicketPolicy !== "never" && (
                <LinearTicketInstructionsField
                  value={data.linearTicketInstructions}
                  disabled={!downstreamEligible || save.isPending}
                  onSave={(v) => patch({ linearTicketInstructions: v })}
                />
              )}
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
          <span className="font-mono">{branch.name}</span>
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
    subtitle: "If set, only error logs that match one of these attributes can create issues.",
    kind: "log",
    mode: "include",
  },
  includeSpans: {
    label: "Include only traces with",
    subtitle: "If set, only exception spans that match one of these attributes can create issues.",
    kind: "span",
    mode: "include",
  },
  excludeLogs: {
    label: "Exclude all logs with",
    subtitle: "Error logs matching any of these are dropped before issue creation.",
    kind: "log",
    mode: "exclude",
  },
  excludeSpans: {
    label: "Exclude all traces with",
    subtitle: "Exception spans matching any of these are dropped before issue creation.",
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
                event of that kind must match at least one to create an issue.
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
                : "Errors that would still create issues (last 24h)"}
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
      <span className="font-mono text-subtle">{clause.key}</span>
      <span className="text-subtle">=</span>
      <span className="font-mono">{clause.value}</span>
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
            ← <span className="truncate font-mono">{drillKey}</span>
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
                      <span className="truncate font-mono text-fg">{r.value || "(empty)"}</span>
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
                  <span className="truncate font-mono text-fg">{k.key}</span>
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
              <span className="font-mono">{e.service || "(no service)"}</span>
              {e.exception_type && <span className="font-mono text-muted">{e.exception_type}</span>}
            </div>
            <span className="font-mono text-[10px] text-subtle">{formatRelative(e.ts)}</span>
          </div>
          <div className="line-clamp-2 break-words font-mono text-[12px] text-fg">
            {e.message || "(no message)"}
          </div>
          <div className="flex flex-wrap gap-1">
            {pickPreviewAttrs(e.attrs, clauseKeys).map(([k, v]) => (
              <span
                key={`${k}=${v}`}
                className="inline-flex items-center gap-1 rounded-sm border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[10.5px] text-muted"
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
          className={`flex h-8 w-8 items-center justify-center rounded-full border font-mono text-[11px] tabular-nums ${
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

function Toggle({
  checked,
  disabled = false,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors ${
        checked ? "border-accent bg-accent" : "border-border bg-surface-3"
      } ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-accent-ink transition-transform ${
          checked ? "translate-x-[18px]" : "translate-x-[2px]"
        }`}
      />
    </button>
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
      <div className="text-[11px] font-mono uppercase tracking-tight text-muted">
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
              className={`rounded-sm border px-2.5 py-1 font-mono text-[11px] tracking-tight transition-colors ${
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
          <div className="text-[11px] font-mono uppercase tracking-tight text-muted">
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
                  className={`rounded-sm border px-2.5 py-1 font-mono text-[11px] tracking-tight transition-colors ${
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

function PolicyControls<T extends string>({
  value,
  disabled,
  onChange,
  labels,
  hints,
}: {
  value: T;
  disabled: boolean;
  onChange: (v: T) => void;
  labels: Record<string, string>;
  hints: Record<string, string>;
}) {
  const options = ["on_ready_to_pr", "always", "never"] as const;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => {
          const active = value === opt;
          return (
            <button
              key={opt}
              type="button"
              disabled={disabled}
              onClick={() => onChange(opt as T)}
              className={`rounded-sm border px-2.5 py-1 font-mono text-[11px] tracking-tight transition-colors ${
                active
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-border bg-surface-2 text-muted hover:text-fg"
              } ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
            >
              {labels[opt]}
            </button>
          );
        })}
      </div>
      <p className="text-[12px] text-muted">{hints[value]}</p>
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
        className="w-full rounded-lg border border-border bg-surface-2 p-3 font-mono text-[12.5px] text-fg placeholder:text-subtle focus:border-border-strong focus:outline-none disabled:opacity-60"
      />
      <div className="flex items-center justify-between text-[12px] text-muted">
        <span>Appended to every agent run prompt for this workspace.</span>
        <span className="font-mono tabular-nums">{draft.length} / 8000</span>
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
        className="w-full rounded-lg border border-border bg-surface-1 p-2 font-mono text-[12px] text-fg placeholder:text-subtle focus:border-border-strong focus:outline-none disabled:opacity-60"
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
          <span className="font-mono text-[11px] uppercase tracking-[0.15em] text-muted">
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
              className="font-mono"
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
                onClick={() => setReveal(null)}
                className="text-[11px] text-muted hover:text-fg"
              >
                dismiss
              </button>
            </div>
            <code className="block break-all font-mono text-[12.5px] text-fg">
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
                  <th className="py-2 pr-4 font-mono text-[10px] uppercase tracking-[0.2em]">
                    Name
                  </th>
                  <th className="py-2 pr-4 font-mono text-[10px] uppercase tracking-[0.2em]">
                    Prefix
                  </th>
                  <th className="py-2 pr-4 font-mono text-[10px] uppercase tracking-[0.2em]">
                    Last used
                  </th>
                  <th className="py-2 font-mono text-[10px] uppercase tracking-[0.2em]" />
                </tr>
              </thead>
              <tbody>
                {live.map((k) => (
                  <tr key={k.id} className="border-b border-border last:border-0">
                    <td className="py-3 pr-4">{k.name}</td>
                    <td className="py-3 pr-4 font-mono tabular-nums text-muted">{k.keyPrefix}…</td>
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
                onClick={() => setReveal(null)}
                className="text-[11px] text-muted hover:text-fg"
              >
                dismiss
              </button>
            </div>
            <code className="block break-all font-mono text-[12.5px] text-fg">
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
                  <th className="py-2 pr-4 font-mono text-[10px] uppercase tracking-[0.2em]">
                    Name
                  </th>
                  <th className="py-2 pr-4 font-mono text-[10px] uppercase tracking-[0.2em]">
                    Prefix
                  </th>
                  <th className="py-2 pr-4 font-mono text-[10px] uppercase tracking-[0.2em]">
                    Last used
                  </th>
                  <th className="py-2 font-mono text-[10px] uppercase tracking-[0.2em]" />
                </tr>
              </thead>
              <tbody>
                {live.map((k) => (
                  <tr key={k.id} className="border-b border-border last:border-0">
                    <td className="py-3 pr-4">{k.name}</td>
                    <td className="py-3 pr-4 font-mono tabular-nums text-muted">{k.key_prefix}…</td>
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
          <span className="font-mono text-[10px] text-muted">{expanded ? "▾" : "▸"}</span>
          <div className="min-w-0">
            <div className="truncate text-[13px] text-fg">
              {install.account_login ?? `Installation ${install.installation_id}`}
            </div>
            <div className="font-mono text-[11px] text-muted">
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
                        <span className="truncate font-mono text-[11px] text-fg">
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
                                  ? "inline-flex items-center gap-1 border border-accent bg-accent/15 px-1.5 py-0.5 font-mono text-[10px] text-accent"
                                  : "inline-flex items-center gap-1 border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted hover:border-fg/40 hover:text-fg"
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

function WebhooksCard({ projectId }: { projectId: string | undefined }) {
  const list = useWebhooks(projectId);
  const create = useCreateWebhook(projectId ?? "");
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [reveal, setReveal] = useState<{ id: string; secret: string } | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [schemaOpen, setSchemaOpen] = useState(false);

  const endpoints = list.data ?? [];

  return (
    <Tile>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-[12px] text-muted">
            One event today: <code className="font-mono text-fg">agent_run.completed</code>. Fires
            when an agent run finishes with findings.
          </p>
          <button
            type="button"
            onClick={() => setSchemaOpen(true)}
            className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted hover:text-fg"
          >
            view payload
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
            disabled={!projectId || !url.trim() || create.isPending}
            loading={create.isPending}
            onClick={async () => {
              if (!projectId || !url.trim()) return;
              try {
                const created = await create.mutateAsync({
                  url: url.trim(),
                  description: description.trim() || undefined,
                });
                if (created.secret) {
                  setReveal({ id: created.id, secret: created.secret });
                }
                setUrl("");
                setDescription("");
              } catch (err) {
                alert(err instanceof Error ? err.message : String(err));
              }
            }}
          >
            Add endpoint
          </Btn>
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
            <code className="block break-all font-mono text-[12.5px] text-fg">{reveal.secret}</code>
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

const AGENT_RUN_COMPLETED_EXAMPLE = `{
  "event": "agent_run.completed",
  "eventId": "5f0a6b6e-...",                       // UUID, unique per event
  "occurredAt": "2026-05-11T12:34:56.000Z",        // when we built the payload
  "project": { "id": "uuid", "name": "Default", "slug": "default" },
  "agentRun": {
    "id": "uuid",
    "state": "complete",                            // always "complete" for this event
    "runtime": "anthropic",                         // agent runtime that ran the agent run
    "completedAt": "2026-05-11T12:34:56.000Z",
    "startedAt": "2026-05-11T12:20:00.000Z",
    "cumulativeRuntimeMinutes": 14,
    "resumeCount": 0,
    "failureReason": null,                          // null for this event (failures don't fire it)
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

const IMPLEMENT_PROMPT = `I want to add a webhook receiver for Superlog's \`agent_run.completed\` event to my app.

Endpoint requirements:
- Accept POST at a route I choose (e.g. /webhooks/superlog). Read the **raw** request body before any JSON parsing — the signature is computed over the raw bytes.
- Headers to handle:
  - \`Superlog-Signature\`: \`t=<unix-ts>,v1=<hex-hmac-sha256>\`. Verify with \`HMAC_SHA256(secret, "<t>.<rawBody>")\` and compare in constant time. Reject if \`|now - t| > 300\` seconds.
  - \`Superlog-Event\`: e.g. \`agent_run.completed\`.
  - \`Superlog-Delivery\`: a UUID that is **stable across retries**. Use it as an idempotency key — if you've already processed it, return 200 without re-running side effects.
- The signing secret comes from env var \`SUPERLOG_WEBHOOK_SECRET\` (starts with \`whsec_\`).
- Respond 2xx within 10 seconds. Do any slow work (DB writes, downstream calls) async / after the response. Non-2xx and timeouts are retried with backoff before attempts 2-8: 30s, 1m, 2m, 5m, 15m, 1h, 6h. After 8 failed attempts the sender gives up.
- On signature failure return 401. On replay (already-seen delivery id) return 200.

Payload shape (\`agent_run.completed\`):
\`\`\`json
{
  "event": "agent_run.completed",
  "eventId": "uuid",
  "occurredAt": "ISO-8601",
  "project": { "id": "uuid", "name": "...", "slug": "..." },
  "agentRun": {
    "id": "uuid",
    "state": "complete",
    "runtime": "anthropic",
    "completedAt": "ISO-8601", "startedAt": "ISO-8601",
    "cumulativeRuntimeMinutes": 14, "resumeCount": 0,
    "failureReason": null,
    "result": {
      "state": "complete",
      "summary": "...",
      "rootCauseConfidence": "high",
      "rootCause": { "text": "...", "confidence": 9 },
      "estimatedImpact": { "text": "...", "confidence": 7 },
      "severity": "SEV-2",
      "pr": {
        "selectedRepoFullName": "owner/repo", "branchName": "...", "baseBranch": "main",
        "openStatus": "opened", "url": "https://github.com/...", "patch": "...",
        "validationPassed": true
      },
      "linearTicket": { "id": "...", "url": "https://linear.app/...", "createdByAgent": true },
      "noiseClassification": null,
      "resolutionClassification": null
    }
  },
  "incident": {
    "id": "uuid", "title": "...", "codename": "...",
    "status": "open",
    "severity": "SEV-2",
    "service": "...",
    "firstSeen": "ISO-8601", "lastSeen": "ISO-8601", "issueCount": 14
  },
  "events": [ { "id": "uuid", "kind": "...", "summary": "...", "detail": {}, "createdAt": "ISO-8601" } ],
  "pullRequests": [ { "id": "uuid", "repoFullName": "owner/repo", "prNumber": 1, "url": "...", "branchName": "...", "baseBranch": "main", "state": "open", "title": "...", "mergedAt": null, "closedAt": null } ],
  "linearTickets": [ { "id": "uuid", "workspaceId": "...", "ticketId": "...", "ticketIdentifier": "ENG-1", "url": "...", "title": "...", "state": "..." } ]
}
\`\`\`

Notes:
- \`agentRun.state\` is always \`"complete"\` for this event.
- \`incident.severity\` and \`result.severity\` are \`"SEV-1" | "SEV-2" | "SEV-3" | null\`.
- \`result.rootCauseConfidence\` is \`"high" | "medium" | "low" | null\`. The \`rootCause\` / \`estimatedImpact\` objects carry a separate 0-10 numeric \`confidence\`.
- \`result.pr\` is present only when a PR was opened. \`result.noiseClassification\` / \`resolutionClassification\` are set when the agent run concluded without a PR. Unknown future fields may appear — treat additively.
- \`pullRequests\` and \`linearTickets\` arrays may be empty.

What to build:
1. The route handler with raw-body access and signature verification.
2. An idempotency store keyed on \`Superlog-Delivery\` (use whatever the codebase already uses — Redis, Postgres, in-memory for dev).
3. A typed payload + a stub handler function the rest of the app can call. For now, just log the agent run summary, PR URL, and Linear ticket URL.
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
              <Label>webhook payload</Label>
              <div className="mt-1 font-mono text-[16px] font-medium text-fg">
                agent_run.completed
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="font-mono text-[11px] uppercase tracking-[0.2em] text-subtle hover:text-fg"
            >
              close
            </button>
          </div>

          <div className="space-y-5">
            <section>
              <h3 className="mb-2 text-[13px] font-medium text-fg">Headers</h3>
              <div className="rounded-sm border border-border bg-surface-2 p-3 font-mono text-[12px]">
                <div>
                  <span className="text-muted">Content-Type:</span> application/json
                </div>
                <div>
                  <span className="text-muted">Superlog-Event:</span> agent_run.completed
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
              <pre className="max-h-[400px] overflow-auto rounded-sm border border-border bg-surface-2 p-3 font-mono text-[11.5px] leading-[1.55] text-fg">
                {AGENT_RUN_COMPLETED_EXAMPLE}
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
                  className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted hover:text-fg"
                >
                  copy
                </button>
              </div>
              <p className="mb-2 text-[12px] text-muted">
                Paste this into Claude Code / Cursor / your IDE agent. It describes the headers,
                signature scheme, payload, and what to build.
              </p>
              <pre className="max-h-[260px] overflow-auto rounded-sm border border-border bg-surface-2 p-3 font-mono text-[11.5px] leading-[1.55] text-fg whitespace-pre-wrap">
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
              <pre className="max-h-[260px] overflow-auto rounded-sm border border-border bg-surface-2 p-3 font-mono text-[11.5px] leading-[1.55] text-fg">
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
                  Response bodies are captured and stored truncated to 2 KiB in the deliveries log.
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

  return (
    <li className="py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={onToggle}
            className="block w-full truncate text-left font-mono text-[12.5px] text-fg hover:underline"
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
      {expanded && <WebhookDeliveriesPanel projectId={projectId} endpointId={endpoint.id} />}
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
              <th className="py-1 pr-3 font-mono text-[10px] uppercase tracking-[0.2em]">When</th>
              <th className="py-1 pr-3 font-mono text-[10px] uppercase tracking-[0.2em]">Event</th>
              <th className="py-1 pr-3 font-mono text-[10px] uppercase tracking-[0.2em]">Status</th>
              <th className="py-1 pr-3 font-mono text-[10px] uppercase tracking-[0.2em]">
                Attempts
              </th>
              <th className="py-1 pr-3 font-mono text-[10px] uppercase tracking-[0.2em]">HTTP</th>
              <th className="py-1 font-mono text-[10px] uppercase tracking-[0.2em]" />
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
        <td className="py-1.5 pr-3 font-mono">{delivery.eventType}</td>
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
            <div className="space-y-1 font-mono text-[11px] text-muted">
              {delivery.lastError && <div>error: {delivery.lastError}</div>}
              {delivery.lastResponseBody && (
                <div>
                  body: <span className="break-all">{delivery.lastResponseBody}</span>
                </div>
              )}
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
