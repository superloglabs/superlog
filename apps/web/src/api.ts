import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4100";

export type Me = {
  user: { id: string; email: string; name: string; isStaff: boolean; impersonating: boolean };
  // Both null when the user signed up but hasn't created their first org yet.
  // The onboarding wizard's create-org step posts to /api/me/orgs to fix that.
  org: { id: string; name: string; slug: string; githubSetupNeeded: boolean } | null;
  project: { id: string; name: string; slug: string; hasIngested: boolean } | null;
  // Whether billing hard-blocks are enforced. Metering runs regardless; this
  // gates the "Ingest paused" bar so we don't show it when nothing is blocked.
  billingEnforcement?: boolean;
};

export type ApiKey = {
  id: string;
  name: string;
  keyPrefix: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  plaintext?: string;
};

export type Stats = {
  window: string;
  traces: number;
  logs: number;
  metrics: number;
  issues: number;
};

export type SystemCapabilities = {
  edition: "community" | "cloud" | "private";
  billing: "none" | "stripe";
  managedAgents: boolean;
  ossAgents: boolean;
  cloudUpgradeLinks: boolean;
};

const SIGNUP_SOURCE_STORAGE_KEY = "superlog.signup_source";

function readPendingSignupSource(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(SIGNUP_SOURCE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function clearPendingSignupSource() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(SIGNUP_SOURCE_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

function useFetcher() {
  return async function fetcher<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      ...((init.headers as Record<string, string> | undefined) ?? {}),
      "content-type": "application/json",
    };
    if (path === "/api/me") {
      const source = readPendingSignupSource();
      if (source) headers["x-superlog-signup-source"] = source;
    }
    const res = await fetch(`${API_URL}${path}`, {
      ...init,
      credentials: "include",
      headers,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`${res.status}: ${body}`);
    }
    return res.json() as Promise<T>;
  };
}

export function useMe() {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      const me = await fetcher<Me>("/api/me");
      // Server only consumes the source once (first time the org has none).
      // Once /api/me has been called with the header, drop the local copy.
      clearPendingSignupSource();
      return me;
    },
  });
}

export function useSystemCapabilities() {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["system-capabilities"],
    queryFn: () => fetcher<SystemCapabilities>("/api/system/capabilities"),
    staleTime: 5 * 60 * 1000,
  });
}

export function useCreateMyFirstOrg() {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      fetcher<{
        org: { id: string; name: string; slug: string };
        project: { id: string; name: string; slug: string };
      }>("/api/me/orgs", { method: "POST", body: JSON.stringify({ name }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });
}

export type SignupIntentClaim = {
  id: string | null;
  keyPrefix: string;
  returnTo: string | null;
  alreadyClaimed: boolean;
};

export function useClaimSignupIntent(projectId: string | undefined) {
  const fetcher = useFetcher();
  return useMutation({
    mutationFn: (intentId: string) =>
      fetcher<SignupIntentClaim>(`/api/signup-intents/${intentId}/claim`, {
        method: "POST",
        body: JSON.stringify({ projectId }),
      }),
  });
}

export type AdminOrgOverviewRow = {
  org: {
    id: string;
    name: string;
    slug: string;
    createdAt: string;
    signupSource: string | null;
  };
  githubConnected: boolean;
  githubConnectedAt: string | null;
  slackConnected: boolean;
  slackConnectedAt: string | null;
  mcpConnected: boolean;
  mcpConnectedAt: string | null;
  members: { userId: string; email: string; name: string | null; joinedAt: string }[];
  thisWeek: { traces: number; incidents: number; prsOpened: number; prsMerged: number };
  prevWeek: { traces: number; incidents: number; prsOpened: number; prsMerged: number };
};

export function useAdminOverview(enabled: boolean) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["admin-org-overview"],
    queryFn: () => fetcher<AdminOrgOverviewRow[]>("/api/admin/org-overview"),
    enabled,
  });
}

export type IncidentEvalFixture = {
  file: string;
  incidentId: string;
  codename: string | null;
  capturedAt: string;
  userPrompt: string;
  referenceOutput: { title: string; summary: string | null };
  humanLabel: { title: string; summary: string; notes: string };
};

export type InvestigationEvalFixture = {
  slug: string;
  incidentId: string;
  title: string;
  service: string | null;
  window: { since: string | null; until: string | null };
  telemetryTables: string[];
  hasCode: boolean;
  hasGroundTruth: boolean;
  hasRubric: boolean;
};

export type AdminEvalsOverview = {
  incidentSummarization: {
    fixturesDir: string;
    fixtures: IncidentEvalFixture[];
    readError: string | null;
  };
  investigations: {
    fixturesDir: string;
    fixtures: InvestigationEvalFixture[];
    readError: string | null;
  };
};

export function useAdminEvals(enabled: boolean) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["admin-evals"],
    queryFn: () => fetcher<AdminEvalsOverview>("/api/admin/evals"),
    enabled,
  });
}

export type InvestigationEvalDetail = {
  slug: string;
  fixturesDir: string;
  incident: {
    id: string;
    title: string;
    service: string | null;
    window: { since: string | null; until: string | null };
  };
  fixture: unknown;
  groundTruth: string | null;
  rubric: unknown | null;
  postgres: Array<{ file: string; json: unknown }>;
  telemetry: Array<{ table: string; path: string; rowCount: number; sample: unknown[] }>;
  code: { artifact: string; bytes: number } | null;
  readError: string | null;
};

export function useAdminInvestigationEval(slug: string | undefined, enabled: boolean) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["admin-investigation-eval", slug],
    queryFn: () =>
      fetcher<InvestigationEvalDetail>(
        `/api/admin/evals/investigations/${encodeURIComponent(slug ?? "")}`,
      ),
    enabled: enabled && !!slug,
  });
}

// --- Feedback ---

export type FeedbackKind = "incident" | "issue" | "pr";
export type FeedbackSource = "dialog" | "slack_button" | "pr_comment" | "pr_link";
export type FeedbackStatus = "new" | "triaged" | "closed";

export type FeedbackRow = {
  id: string;
  kind: FeedbackKind;
  refId: string;
  refRepo: string | null;
  source: FeedbackSource;
  body: string;
  authorEmail: string | null;
  authorExternal: {
    githubLogin?: string;
    githubCommentUrl?: string;
    slackUserId?: string;
    slackTeamId?: string;
  } | null;
  orgId: string | null;
  projectId: string | null;
  status: FeedbackStatus;
  triagedByEmail: string | null;
  triagedAt: string | null;
  createdAt: string;
};

export function useSubmitFeedback() {
  const fetcher = useFetcher();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      kind: "incident" | "issue";
      refId: string;
      body: string;
      projectId?: string;
    }) =>
      fetcher<{ ok: true }>("/api/feedback", {
        method: "POST",
        body: JSON.stringify(vars),
      }),
    onSuccess: () => {
      // Refresh the admin badge optimistically for staff users; non-staff
      // get a 403 and the query just stays empty, which is fine.
      queryClient.invalidateQueries({ queryKey: ["admin-feedback-unread"] });
    },
  });
}

// Anonymous PR-link submissions go to a different (public) endpoint that
// doesn't require credentials, so we use plain fetch instead of the
// cookie-bearing useFetcher.
const API_URL_FOR_FEEDBACK = import.meta.env.VITE_API_URL ?? "http://localhost:4100";
export function submitPrFeedback(opts: {
  owner: string;
  repo: string;
  prNumber: number;
  body: string;
  githubLogin?: string;
}): Promise<{ ok: true }> {
  return fetch(`${API_URL_FOR_FEEDBACK}/feedback/pr/${opts.owner}/${opts.repo}/${opts.prNumber}`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body: opts.body, githubLogin: opts.githubLogin }),
  }).then(async (res) => {
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    return res.json() as Promise<{ ok: true }>;
  });
}

export function useAdminFeedback(enabled: boolean, status: "all" | FeedbackStatus = "all") {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["admin-feedback", status],
    queryFn: () =>
      fetcher<{ rows: FeedbackRow[] }>(
        status === "all" ? "/api/admin/feedback" : `/api/admin/feedback?status=${status}`,
      ),
    enabled,
  });
}

export function useAdminFeedbackUnreadCount(enabled: boolean) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["admin-feedback-unread"],
    queryFn: () => fetcher<{ count: number }>("/api/admin/feedback/unread-count"),
    enabled,
    refetchInterval: 30_000,
  });
}

export function useUpdateFeedbackStatus() {
  const fetcher = useFetcher();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; status: FeedbackStatus }) =>
      fetcher<{ ok: true }>(`/api/admin/feedback/${vars.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: vars.status }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-feedback"] });
      queryClient.invalidateQueries({ queryKey: ["admin-feedback-unread"] });
    },
  });
}

export type WebhookEndpoint = {
  id: string;
  url: string;
  description: string | null;
  enabledEvents: string[];
  disabledAt: string | null;
  createdAt: string;
  updatedAt: string;
  secret?: string;
};

export type WebhookDelivery = {
  id: string;
  eventType: string;
  status: "pending" | "success" | "failed";
  attemptCount: number;
  nextAttemptAt: string;
  lastAttemptAt: string | null;
  lastResponseStatus: number | null;
  lastResponseBody: string | null;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string;
};

export function useWebhooks(projectId: string | undefined) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["webhooks", projectId],
    queryFn: () => fetcher<WebhookEndpoint[]>(`/api/projects/${projectId}/webhooks`),
    enabled: !!projectId,
  });
}

export function useCreateWebhook(projectId: string) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { url: string; description?: string }) =>
      fetcher<WebhookEndpoint>(`/api/projects/${projectId}/webhooks`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["webhooks", projectId] }),
  });
}

export function useUpdateWebhook(projectId: string) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; url?: string; description?: string; disabled?: boolean }) =>
      fetcher<WebhookEndpoint>(`/api/projects/${projectId}/webhooks/${vars.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          url: vars.url,
          description: vars.description,
          disabled: vars.disabled,
        }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["webhooks", projectId] }),
  });
}

export function useDeleteWebhook(projectId: string) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      fetcher<{ ok: true }>(`/api/projects/${projectId}/webhooks/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["webhooks", projectId] }),
  });
}

export function useRotateWebhookSecret(projectId: string) {
  const fetcher = useFetcher();
  return useMutation({
    mutationFn: (id: string) =>
      fetcher<{ id: string; secret: string }>(
        `/api/projects/${projectId}/webhooks/${id}/rotate-secret`,
        { method: "POST" },
      ),
  });
}

export function useTestWebhook(projectId: string) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      fetcher<{ deliveryId: string | null }>(`/api/projects/${projectId}/webhooks/${id}/test`, {
        method: "POST",
      }),
    onSuccess: (_data, id) =>
      qc.invalidateQueries({ queryKey: ["webhook-deliveries", projectId, id] }),
  });
}

export function useWebhookDeliveries(
  projectId: string | undefined,
  endpointId: string | undefined,
) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["webhook-deliveries", projectId, endpointId],
    queryFn: () =>
      fetcher<WebhookDelivery[]>(`/api/projects/${projectId}/webhooks/${endpointId}/deliveries`),
    enabled: !!projectId && !!endpointId,
    refetchInterval: 4000,
  });
}

export function useRedeliverWebhook(projectId: string, endpointId: string) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (deliveryId: string) =>
      fetcher<{ deliveryId: string | null }>(
        `/api/projects/${projectId}/webhooks/${endpointId}/deliveries/${deliveryId}/redeliver`,
        { method: "POST" },
      ),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["webhook-deliveries", projectId, endpointId] }),
  });
}

export function useKeys(projectId: string | undefined) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["keys", projectId],
    queryFn: () => fetcher<ApiKey[]>(`/api/projects/${projectId}/keys`),
    enabled: !!projectId,
  });
}

export function useCreateKey(projectId: string) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      fetcher<ApiKey>(`/api/projects/${projectId}/keys`, {
        method: "POST",
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["keys", projectId] }),
  });
}

export function useRevokeKey(projectId: string) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (keyId: string) =>
      fetcher<{ ok: true }>(`/api/projects/${projectId}/keys/${keyId}`, {
        method: "DELETE",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["keys", projectId] }),
  });
}

// Org-scoped management API keys (sl_management_*). These authenticate the
// provisioning API at /api/v1/*. Separate from per-project ingest keys.
export type OrgApiKey = {
  id: string;
  name: string;
  key_prefix: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

export type MintedOrgApiKey = OrgApiKey & { plaintext: string };

export function useOrgApiKeys() {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["org-api-keys"],
    queryFn: () => fetcher<{ keys: OrgApiKey[] }>("/api/org/api-keys"),
  });
}

export function useMintOrgApiKey() {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      fetcher<{ key: MintedOrgApiKey }>("/api/org/api-keys", {
        method: "POST",
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["org-api-keys"] }),
  });
}

export function useRevokeOrgApiKey() {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (keyId: string) =>
      fetcher<{ ok: true }>(`/api/org/api-keys/${keyId}`, {
        method: "DELETE",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["org-api-keys"] }),
  });
}

// Mints an org-scoped GitHub install URL on behalf of the dashboard admin.
// Same shape the management API produces, but auth-gated on the Better Auth
// session cookie — admins don't need to mint a management key first.
export function useMintOrgGithubInstallUrl() {
  const fetcher = useFetcher();
  return useMutation({
    mutationFn: () =>
      fetcher<{ install_url: string }>("/api/org/github/install-url", {
        method: "POST",
        body: JSON.stringify({}),
      }),
  });
}

export type OrgGithubInstallation = {
  id: string;
  installation_id: number;
  account_login: string | null;
  account_type: string | null;
  created_at: string;
};

export function useOrgGithubInstallations() {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["org-github-installations"],
    queryFn: () =>
      fetcher<{ installations: OrgGithubInstallation[] }>("/api/org/github/installations"),
  });
}

export type OrgGithubInstallRepo = { id: number; full_name: string; private: boolean };

// Live-fetched from GitHub on demand. `enabled` lets the caller hold off
// until the install card is actually expanded (avoids burning a token swap
// per-install on page load when the user may not look at any).
export function useOrgGithubInstallRepos(rowId: string | null) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["org-github-install-repos", rowId],
    enabled: !!rowId,
    queryFn: () =>
      fetcher<{ repos: OrgGithubInstallRepo[]; truncated: boolean }>(
        `/api/org/github/installations/${rowId}/repos`,
      ),
  });
}

export type OrgGithubInstallGrant = {
  id: string;
  project_id: string;
  repo_id: number;
  repo_full_name: string;
  created_at: string;
};

export function useOrgGithubInstallGrants(rowId: string | null) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["org-github-install-grants", rowId],
    enabled: !!rowId,
    queryFn: () =>
      fetcher<{ grants: OrgGithubInstallGrant[] }>(`/api/org/github/installations/${rowId}/grants`),
  });
}

export function useRevokeOrgGithubInstallation() {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rowId: string) =>
      fetcher<{ ok: true }>(`/api/org/github/installations/${rowId}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["org-github-installations"] });
    },
  });
}

export function useGrantOrgRepoToProject() {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { projectId: string; installationRowId: string; repoId: number }) =>
      fetcher<{ grant: OrgGithubInstallGrant }>(
        `/api/org/projects/${args.projectId}/github/repos`,
        {
          method: "POST",
          body: JSON.stringify({
            installation_id: args.installationRowId,
            repo_id: args.repoId,
          }),
        },
      ),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["org-github-install-grants", vars.installationRowId] });
      // Project-scoped GitHub installation view depends on grants too — bust
      // the cache so /api/github/installation refetches.
      qc.invalidateQueries({ queryKey: ["github-installation"] });
    },
  });
}

export function useRevokeOrgRepoFromProject() {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { projectId: string; installationRowId: string; repoId: number }) =>
      fetcher<{ ok: true }>(`/api/org/projects/${args.projectId}/github/repos/${args.repoId}`, {
        method: "DELETE",
      }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["org-github-install-grants", vars.installationRowId] });
      qc.invalidateQueries({ queryKey: ["github-installation"] });
    },
  });
}

export type GithubInstallation =
  | { installed: false }
  | {
      installed: true;
      installationId: number;
      accountLogin: string | null;
      manageUrl: string;
      repoVerificationUnavailable?: boolean;
      installations: {
        installationId: number;
        accountLogin: string | null;
        accountType: string | null;
        enabled: boolean;
        manageUrl: string;
        repos: { id: number; fullName: string; private: boolean; enabled: boolean }[];
      }[];
      repos: { id: number; fullName: string; private: boolean; enabled: boolean }[];
      commitAuthor: {
        source: "app" | "github_user";
        name: string;
        email: string;
        githubLogin: string | null;
        githubId: number | null;
        avatarUrl: string | null;
        setAt: string | null;
      } | null;
    };

export function useGithubInstallation() {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["github-installation"],
    queryFn: () => fetcher<GithubInstallation>("/api/github/installation"),
    // Poll while the dashboard is open so the setup stepper picks up an
    // OAuth that completed in another tab without needing a refocus.
    refetchInterval: 15000,
  });
}

export function useStartGithubInstall() {
  const fetcher = useFetcher();
  return useMutation({
    mutationFn: () => fetcher<{ url: string }>("/api/github/install-url", { method: "POST" }),
  });
}

export function useStartGithubAuthorLogin() {
  const fetcher = useFetcher();
  return useMutation({
    mutationFn: () => fetcher<{ url: string }>("/api/github/author-login-url", { method: "POST" }),
  });
}

export function useStartGithubAccessLogin() {
  const fetcher = useFetcher();
  return useMutation({
    mutationFn: () => fetcher<{ url: string }>("/api/github/access-login-url", { method: "POST" }),
  });
}

export function useUpdateGithubRepoAccess() {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      installationId: number;
      enabled?: boolean;
      repoId?: number;
      repoEnabled?: boolean;
    }) =>
      fetcher<{ ok: true }>("/api/github/repo-access", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["github-installation"] }),
  });
}

export function useResetGithubCommitAuthor() {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => fetcher<{ ok: true }>("/api/github/commit-author/reset", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["github-installation"] }),
  });
}

export function useSkipGithub() {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => fetcher<{ ok: true; orgId: string }>("/api/github/skip", { method: "POST" }),
    onSuccess: () => {
      qc.setQueryData<Me>(["me"], (current) =>
        current?.org
          ? {
              ...current,
              org: { ...current.org, githubSetupNeeded: false },
            }
          : current,
      );
      return qc.invalidateQueries({ queryKey: ["me"] });
    },
  });
}

export type SlackInstallation =
  | { installed: false }
  | { installed: true; teamId: string; teamName: string | null };

export type SlackChannel = { id: string; name: string; isPrivate: boolean };

export type SlackRoute =
  | { configured: false }
  | { configured: true; channelId: string; channelName: string | null };

export function useSlackInstallation() {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["slack-installation"],
    queryFn: () => fetcher<SlackInstallation>("/api/slack/installation"),
    // Poll like the github query so the setup stepper picks up OAuth
    // completion without a manual refresh.
    refetchInterval: 15000,
  });
}

export function useStartSlackInstall() {
  const fetcher = useFetcher();
  return useMutation({
    mutationFn: () => fetcher<{ url: string }>("/api/slack/install-url", { method: "POST" }),
  });
}

export function useUninstallSlack() {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => fetcher<{ ok: true }>("/api/slack/uninstall", { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["slack-installation"] });
      qc.invalidateQueries({ queryKey: ["slack-channels"] });
    },
  });
}

export function useSlackChannels(enabled: boolean) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["slack-channels"],
    queryFn: () => fetcher<{ channels: SlackChannel[] }>("/api/slack/channels"),
    enabled,
  });
}

export function useSlackRoute(projectId: string | undefined) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["slack-route", projectId],
    queryFn: () => fetcher<SlackRoute>(`/api/projects/${projectId}/slack-route`),
    enabled: !!projectId,
  });
}

export function useSetSlackRoute(projectId: string) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ch: SlackChannel) =>
      fetcher<{ ok: true }>(`/api/projects/${projectId}/slack-route`, {
        method: "PUT",
        body: JSON.stringify({ channelId: ch.id, channelName: ch.name }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["slack-route", projectId] }),
  });
}

export function useDeleteSlackRoute(projectId: string) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      fetcher<{ ok: true }>(`/api/projects/${projectId}/slack-route`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["slack-route", projectId] }),
  });
}

export type LinearInstallation =
  | { installed: false }
  | {
      installed: true;
      workspaceId: string;
      workspaceName: string | null;
      workspaceUrlKey: string | null;
      actorEmail: string | null;
      scope: string | null;
      needsReauth: boolean;
      reauthReason: string | null;
      reauthRequiredAt: string | null;
    };

export function useLinearInstallation() {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["linear-installation"],
    queryFn: () => fetcher<LinearInstallation>("/api/linear/installation"),
  });
}

export function useStartLinearInstall() {
  const fetcher = useFetcher();
  return useMutation({
    mutationFn: () => fetcher<{ url: string }>("/api/linear/install-url", { method: "POST" }),
  });
}

export function useUninstallLinear() {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => fetcher<{ ok: true }>("/api/linear/uninstall", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["linear-installation"] }),
  });
}

export type OrgProject = { id: string; name: string; slug: string };

export function useOrgProjects() {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["org-projects"],
    queryFn: () => fetcher<{ projects: OrgProject[] }>("/api/org/projects"),
  });
}

export function useCreateOrgProject() {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; slug?: string }) =>
      fetcher<{ project: OrgProject }>("/api/org/projects", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["org-projects"] }),
  });
}

export function useUpdateOrgProject() {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      patch,
    }: {
      projectId: string;
      patch: { name?: string; slug?: string };
    }) =>
      fetcher<{ project: OrgProject }>(`/api/org/projects/${projectId}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["org-projects"] });
      qc.invalidateQueries({ queryKey: ["me"] });
    },
  });
}

export function useDeleteOrgProject() {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) =>
      fetcher<{ ok: true }>(`/api/org/projects/${projectId}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["org-projects"] });
      qc.invalidateQueries({ queryKey: ["me"] });
    },
  });
}

export function useSetActiveProject() {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) =>
      fetcher<{ project: OrgProject }>("/api/me/active-project", {
        method: "PUT",
        body: JSON.stringify({ projectId }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });
}

export type LinearTicketPolicy = "never" | "on_ready_to_pr" | "always";
export type PrPolicy = "never" | "on_ready_to_pr" | "always";
export type AutoMergePolicy = "never" | "when_checks_pass" | "immediately";
export type AutoMergeMethod = "squash" | "merge" | "rebase";

export type LinearTicketInstruction = {
  id: string;
  title: string;
  text: string;
};

export type IssueFilterClause = { key: string; value: string };

export type IssueFilterConfig = {
  includeLogs: IssueFilterClause[];
  includeSpans: IssueFilterClause[];
  excludeLogs: IssueFilterClause[];
  excludeSpans: IssueFilterClause[];
};

export const EMPTY_ISSUE_FILTER_CONFIG: IssueFilterConfig = {
  includeLogs: [],
  includeSpans: [],
  excludeLogs: [],
  excludeSpans: [],
};

export type AgentSettings = {
  customInstructions: string;
  agentRunEnabled: boolean;
  linearTicketPolicy: LinearTicketPolicy;
  linearTicketInstructions: LinearTicketInstruction[];
  prPolicy: PrPolicy;
  autoMergeFixPrs: AutoMergePolicy;
  autoMergeMethod: AutoMergeMethod;
  issueFilterConfig: IssueFilterConfig;
};

export function useAgentSettings(projectId: string | undefined) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["agent-settings", projectId],
    queryFn: () => fetcher<AgentSettings>(`/api/projects/${projectId}/automation`),
    enabled: !!projectId,
  });
}

export function useSaveAgentSettings(projectId: string | undefined) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<AgentSettings>) =>
      fetcher<AgentSettings>(`/api/projects/${projectId}/automation`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agent-settings", projectId] }),
  });
}

export type IssueFilterPreviewEvent = {
  kind: "log" | "span";
  ts: string;
  service: string;
  message: string;
  exception_type: string;
  attrs: Record<string, string>;
};

export function useIssueFilterAttributeKeys(projectId: string | undefined) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["issue-filter", "attribute-keys", projectId],
    queryFn: () =>
      fetcher<{ key: string; count: number }[]>(
        `/api/projects/${projectId}/issue-filter/attribute-keys`,
      ),
    enabled: !!projectId,
    staleTime: 60_000,
  });
}

export function useIssueFilterAttributeValues(
  projectId: string | undefined,
  key: string | undefined,
) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["issue-filter", "attribute-values", projectId, key],
    queryFn: () => {
      if (!projectId || !key) return Promise.resolve([]);
      return fetcher<{ value: string; count: number }[]>(
        `/api/projects/${projectId}/issue-filter/attribute-values?key=${encodeURIComponent(key)}`,
      );
    },
    enabled: !!projectId && !!key,
    staleTime: 60_000,
  });
}

export function useIssueFilterPreview(projectId: string | undefined, config: IssueFilterConfig) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["issue-filter", "preview", projectId, config],
    queryFn: () =>
      fetcher<{ events: IssueFilterPreviewEvent[] }>(
        `/api/projects/${projectId}/issue-filter/preview`,
        { method: "POST", body: JSON.stringify({ config }) },
      ),
    enabled: !!projectId,
    staleTime: 15_000,
  });
}

export type OrgAgentSettings = {
  customInstructions: string;
};

export function useOrgAgentSettings() {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["org-agent-settings"],
    queryFn: () => fetcher<OrgAgentSettings>("/api/org/agent-settings"),
  });
}

export function useSaveOrgAgentSettings() {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: OrgAgentSettings) =>
      fetcher<OrgAgentSettings>("/api/org/agent-settings", {
        method: "PUT",
        body: JSON.stringify(patch),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["org-agent-settings"] }),
  });
}

export type OrgDigestSettings = {
  enabled: boolean;
  channelId: string | null;
  channelName: string | null;
  installationId: string | null;
  lastRunAt: string | null;
};

export function useOrgDigest() {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["org-digest"],
    queryFn: () => fetcher<OrgDigestSettings>("/api/org/digest"),
  });
}

export function useSaveOrgDigest() {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: {
      enabled?: boolean;
      channelId?: string | null;
      channelName?: string | null;
    }) =>
      fetcher<OrgDigestSettings>("/api/org/digest", {
        method: "PUT",
        body: JSON.stringify(patch),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["org-digest"] }),
  });
}

export function useRunOrgDigestNow() {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => fetcher<{ ok: true }>("/api/org/digest/run-now", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["org-digest"] }),
  });
}

export type IntegrationSecretSpec = {
  name: string;
  description: string;
  present: boolean;
};

export type Integration = {
  slug: string;
  name: string;
  description: string;
  installed: boolean;
  enabled: boolean;
  required_secrets: IntegrationSecretSpec[];
};

export function useIntegrations() {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["integrations"],
    queryFn: () => fetcher<{ integrations: Integration[] }>("/api/org/integrations"),
  });
}

export function useSaveIntegration() {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      slug: string;
      enabled?: boolean;
      secrets?: Record<string, string | null>;
    }) =>
      fetcher<{ ok: true }>(`/api/org/integrations/${vars.slug}`, {
        method: "PUT",
        body: JSON.stringify({ enabled: vars.enabled, secrets: vars.secrets }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["integrations"] }),
  });
}

export function useRemoveIntegration() {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) =>
      fetcher<{ ok: true }>(`/api/org/integrations/${slug}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["integrations"] }),
  });
}

export function useStats(projectId: string | undefined, opts: { poll?: boolean } = {}) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["stats", projectId],
    queryFn: () => fetcher<Stats>(`/api/projects/${projectId}/stats`),
    enabled: !!projectId,
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    refetchInterval: opts.poll ? 5000 : false,
  });
}

// Cancels the org's active paid plan immediately and lands it back on Free
// (server-side — Autumn's client/better-auth plugin doesn't expose cancel).
export function useCancelBilling() {
  const fetcher = useFetcher();
  return useMutation({
    mutationFn: () => fetcher<{ ok: boolean }>("/api/me/billing/cancel", { method: "POST" }),
  });
}

export function useMcpStatus(projectId: string | undefined) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["mcp-status", projectId],
    queryFn: () => fetcher<{ connected: boolean }>(`/api/projects/${projectId}/mcp-status`),
    enabled: !!projectId,
    // Re-check periodically so the MCP todo disappears within a few seconds
    // of the user completing the OAuth flow in their agent.
    refetchInterval: 10000,
  });
}

// Issues ---------------------------------------------------------------------

export type IssueSample = {
  kind: "span" | "log";
  service: string | null;
  severity: string | null;
  message: string | null;
  body: string | null;
  exceptionType: string;
  topFrame: string | null;
  normalizedFrames: string[];
  stacktrace: string | null;
  seenAt: string;
  traceId?: string | null;
  spanId?: string | null;
  severityNumber?: number | null;
  logAttrs?: Record<string, string> | null;
  resourceAttrs?: Record<string, string> | null;
};

export type Issue = {
  id: string;
  projectId: string;
  fingerprint: string;
  kind: string;
  service: string | null;
  exceptionType: string;
  title: string;
  message: string | null;
  topFrame: string | null;
  firstSeen: string;
  lastSeen: string;
  silencedAt: string | null;
  eventCount: number;
  groupingState: "grouped" | "pending" | "standalone" | "failed";
  groupingSource: "heuristic" | "llm" | "manual" | null;
  groupingReason: string | null;
  lastSample: IssueSample | null;
  createdAt: string;
};

export function useIssues(
  projectId: string | undefined,
  silenced: "active" | "silenced" | "all" = "active",
  opts: { groupingFilter?: "ungrouped" } = {},
) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["issues", projectId, silenced, opts.groupingFilter ?? "all"],
    queryFn: () => {
      const params = new URLSearchParams({ silenced, limit: "200" });
      if (opts.groupingFilter) params.set("grouping", opts.groupingFilter);
      return fetcher<Issue[]>(`/api/projects/${projectId}/issues?${params.toString()}`);
    },
    enabled: !!projectId,
  });
}

export function useIssue(projectId: string | undefined, issueId: string | undefined) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["issue", projectId, issueId],
    queryFn: () => fetcher<Issue>(`/api/projects/${projectId}/issues/${issueId}`),
    enabled: !!projectId && !!issueId,
  });
}

export function useIssueForLog(projectId: string | undefined, log: LogRow | null) {
  const fetcher = useFetcher();
  const isError = (log?.severity_number ?? 0) >= 17;
  const key = log
    ? {
        service: log.service ?? "",
        severity: log.severity ?? "",
        body: log.body ?? "",
        exceptionType: log.log_attrs?.["exception.type"] ?? null,
        stacktrace: log.log_attrs?.["exception.stacktrace"] ?? null,
      }
    : null;
  return useQuery({
    queryKey: ["issue-for-log", projectId, key],
    queryFn: () =>
      fetcher<{ issue: Issue | null }>(`/api/projects/${projectId}/issues/lookup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "log", ...key }),
      }),
    enabled: !!projectId && !!log && isError,
  });
}

export type AgentRunFailureReason =
  | "agent_no_findings"
  | "patch_validation_failed"
  | "pr_open_failed"
  | "terminated_without_result"
  | "runtime_budget_exhausted"
  | "human_resume_budget_exhausted"
  | "start_failed"
  | "sync_failed"
  | "resume_failed"
  | "missing_session"
  | "missing_session_for_resume"
  | "github_repo_discovery_failed"
  | "github_repo_token_failed"
  | "unsupported_provider";

export type AgentRunFailureCategory = "agent" | "deliverable" | "infra";

export function agentRunFailureCategory(reason: AgentRunFailureReason): AgentRunFailureCategory {
  switch (reason) {
    case "agent_no_findings":
      return "agent";
    case "patch_validation_failed":
    case "pr_open_failed":
      return "deliverable";
    default:
      return "infra";
  }
}

export type AgentRunPr = {
  selectedRepoFullName: string;
  branchName: string;
  baseBranch: string;
  title?: string | null;
  body?: string | null;
  patch?: string;
  patchFileId?: string | null;
  patchFilePath?: string | null;
  validationPassed: boolean;
  validationCommands?: string[];
  validationSummary?: string | null;
  changedFiles?: string[];
  openStatus: "pending" | "opened";
  url?: string | null;
};

export type AgentRunLinearTicket = {
  id: string;
  url?: string | null;
  createdByAgent: boolean;
};

export type IncidentSeverity = "SEV-1" | "SEV-2" | "SEV-3";

export type IncidentNoiseReason =
  | "cosmetic_log_only"
  | "lifecycle_signal"
  | "self_telemetry"
  | "expected_third_party"
  | "confusing_log_no_impact";

export type IncidentNoiseClassification = {
  reason: IncidentNoiseReason;
  evidence: string;
};

export type IncidentResolutionReason =
  | "fixed_in_current_code"
  | "transient_condition_cleared"
  | "upstream_recovered";

export type IncidentResolutionClassification = {
  reason: IncidentResolutionReason;
  evidence: string;
};

export type AgentRunConfidence = {
  text: string;
  confidence: number;
};

export type AgentRunResult = {
  state: "complete" | "awaiting_human" | "failed";
  summary: string;
  question?: string | null;
  failureReason?: AgentRunFailureReason | null;
  pr?: AgentRunPr | null;
  linearTicket?: AgentRunLinearTicket | null;
  rootCauseConfidence?: "high" | "medium" | "low" | null;
  proposedTitle?: string | null;
  rootCause?: AgentRunConfidence | null;
  estimatedImpact?: AgentRunConfidence | null;
  severity?: IncidentSeverity | null;
  noiseClassification?: IncidentNoiseClassification | null;
  resolutionClassification?: IncidentResolutionClassification | null;
};

export type AgentRun = {
  id: string;
  incidentId: string;
  runtime: string;
  state: string;
  providerSessionId: string | null;
  selectedRepoFullName: string | null;
  selectedRepoUrl: string | null;
  selectedBaseBranch: string | null;
  cumulativeRuntimeMinutes: number;
  resumeCount: number;
  startedAt: string | null;
  completedAt: string | null;
  failureReason: string | null;
  result: AgentRunResult | null;
  createdAt: string;
  updatedAt: string;
};

export type AgentRunEventActor = {
  name: string | null;
  avatarUrl: string | null;
  profileUrl: string | null;
};

export type IncidentEvent = {
  id: string;
  agentRunId: string;
  kind: string;
  summary: string | null;
  detail: Record<string, unknown> | null;
  // Optional in client code: design fixtures predate this field. At runtime
  // the API always populates it, but consumers should still fall back to `id`.
  providerEventId?: string | null;
  createdAt: string;
  source?: "agent_run" | "agent_pr" | "agent_linear";
  actor?: AgentRunEventActor | null;
};

export type IncidentSummary = {
  id: string;
  title: string;
  status: string;
  firstSeen: string;
  lastSeen: string;
};

export type Incident = {
  id: string;
  projectId: string;
  service: string | null;
  title: string;
  codename: string;
  severity: IncidentSeverity | null;
  status: string;
  noiseReason: IncidentNoiseReason | null;
  noiseResolvedAt: string | null;
  firstSeen: string;
  lastSeen: string;
  issueCount: number;
  slackChannelId: string | null;
  slackThreadTs: string | null;
  // Findings flattened from the latest successful agent run.
  agentSummary: string | null;
  rootCauseText: string | null;
  rootCauseConfidence: number | null;
  estimatedImpactText: string | null;
  estimatedImpactConfidence: number | null;
  suggestedSeverity: IncidentSeverity | null;
  noiseClassification: IncidentNoiseClassification | null;
  resolutionClassification: IncidentResolutionClassification | null;
  findingsAgentRunId: string | null;
  createdAt: string;
  updatedAt: string;
};

// One open (decision IS NULL) resolution proposal per incident — see
// `incident_resolution_proposals` in packages/db/src/schema.ts. The
// dashboard surfaces this as a chip on the row + a banner on the detail
// view with Confirm/Dismiss buttons.
export type PendingResolutionProposal = {
  id: string;
  sourceKind: string;
  confidence: "low" | "medium" | "high";
  proposedReasonCode: string;
  proposedReasonText: string;
  proposedAt: string;
};

export type IncidentListItem = {
  incident: Incident;
  agentRun: AgentRun | null;
  // Optional legacy inline row activity. The incidents page normally lazy-loads
  // this through `/incidents/:id/stats` so the list does not block on ClickHouse.
  windowDays?: number;
  buckets?: { day: string; count: number }[];
  impactedUsers?: number;
  impactedUsersAvailable?: boolean;
  impactedUsersCapped?: boolean;
  pendingResolutionProposal: PendingResolutionProposal | null;
};

export type IncidentDetail = {
  incident: Incident;
  issues: Issue[];
  // Latest agent run, for backward compatibility with code that checks status.
  agentRun: AgentRun | null;
  // Full agent-run history for this incident, newest first.
  agentRuns: AgentRun[];
  // Timeline events scoped to the latest run, plus PR/Linear ticket events.
  // Empty array when there is no agent run yet.
  timeline: IncidentEvent[];
  pendingResolutionProposal: PendingResolutionProposal | null;
};

export function useIncidents(
  projectId: string | undefined,
  status: "open" | "resolved" | "autoresolved_noise" | "all" = "open",
) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["incidents", projectId, status],
    queryFn: () =>
      fetcher<IncidentListItem[]>(
        `/api/projects/${projectId}/incidents?status=${status}&limit=200`,
      ),
    enabled: !!projectId,
  });
}

export function useIncident(projectId: string | undefined, incidentId: string | undefined) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["incident", projectId, incidentId],
    queryFn: () => fetcher<IncidentDetail>(`/api/projects/${projectId}/incidents/${incidentId}`),
    enabled: !!projectId && !!incidentId,
  });
}

export type IncidentAgentRun = {
  agentRun: AgentRun | null;
  events: IncidentEvent[];
};

export type IncidentStats = {
  windowDays: number;
  buckets: { day: string; count: number }[];
  totalEvents: number;
  impactedUsers: number;
  impactedUsersAvailable: boolean;
};

export function useIncidentStats(
  projectId: string | undefined,
  incidentId: string | undefined,
  opts: { enabled?: boolean } = {},
) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["incident-stats", projectId, incidentId],
    queryFn: () =>
      fetcher<IncidentStats>(`/api/projects/${projectId}/incidents/${incidentId}/stats`),
    enabled: !!projectId && !!incidentId && (opts.enabled ?? true),
  });
}

export function useIncidentAgentRun(projectId: string | undefined, incidentId: string | undefined) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["incident-agent run", projectId, incidentId],
    queryFn: () =>
      fetcher<IncidentAgentRun>(`/api/projects/${projectId}/incidents/${incidentId}/agent-run`),
    enabled: !!projectId && !!incidentId,
  });
}

export function useRestartAgentRun(projectId: string) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (incidentId: string) =>
      fetcher<AgentRun>(`/api/projects/${projectId}/incidents/${incidentId}/agent-run/restart`, {
        method: "POST",
      }),
    onSuccess: (_agentRun, incidentId) => {
      qc.invalidateQueries({ queryKey: ["incidents", projectId] });
      qc.invalidateQueries({ queryKey: ["incident", projectId, incidentId] });
      qc.invalidateQueries({ queryKey: ["incident-agent run", projectId, incidentId] });
    },
  });
}

export function useRetryPrDelivery(projectId: string) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (incidentId: string) =>
      fetcher<AgentRun>(`/api/projects/${projectId}/incidents/${incidentId}/agent-run/retry-pr`, {
        method: "POST",
      }),
    onSuccess: (_agentRun, incidentId) => {
      qc.invalidateQueries({ queryKey: ["incidents", projectId] });
      qc.invalidateQueries({ queryKey: ["incident", projectId, incidentId] });
      qc.invalidateQueries({ queryKey: ["incident-agent run", projectId, incidentId] });
    },
  });
}

export function useDecideResolutionProposal(projectId: string) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      incidentId,
      proposalId,
      decision,
    }: {
      incidentId: string;
      proposalId: string;
      decision: "confirm" | "dismiss";
    }) =>
      fetcher<{ ok: true; incidentId: string; proposalId: string; decision: string }>(
        `/api/projects/${projectId}/incidents/${incidentId}/resolution-proposals/${proposalId}/${decision}`,
        { method: "POST" },
      ),
    onSuccess: (_data, vars) => {
      // Confirm flips the incident closed; dismiss leaves it open. Either
      // way the chip/banner should disappear, so we invalidate the same
      // queries either button click touches.
      qc.invalidateQueries({ queryKey: ["incidents", projectId] });
      qc.invalidateQueries({ queryKey: ["incident", projectId, vars.incidentId] });
      qc.invalidateQueries({
        queryKey: ["incident-investigation", projectId, vars.incidentId],
      });
    },
  });
}

export function useUpdateIncident(projectId: string) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { incidentId: string; status: "open" | "resolved" }) =>
      fetcher<Incident>(`/api/projects/${projectId}/incidents/${vars.incidentId}`, {
        method: "PATCH",
        body: JSON.stringify({ status: vars.status }),
      }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["incidents", projectId] });
      qc.invalidateQueries({ queryKey: ["incident", projectId, vars.incidentId] });
    },
  });
}

export type IssueAgentRun = {
  incident: IncidentSummary | null;
  agentRun: AgentRun | null;
  events: IncidentEvent[];
};

export function useIssueAgentRun(projectId: string | undefined, issueId: string | undefined) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["issue-agent run", projectId, issueId],
    queryFn: () => fetcher<IssueAgentRun>(`/api/projects/${projectId}/issues/${issueId}/agent-run`),
    enabled: !!projectId && !!issueId,
  });
}

export function useSilenceIssue(projectId: string) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (issueId: string) =>
      fetcher<Issue>(`/api/projects/${projectId}/issues/${issueId}/silence`, {
        method: "POST",
      }),
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: ["issues", projectId] });
      qc.setQueryData(["issue", projectId, updated.id], updated);
    },
  });
}

export function useUnsilenceIssue(projectId: string) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (issueId: string) =>
      fetcher<Issue>(`/api/projects/${projectId}/issues/${issueId}/unsilence`, {
        method: "POST",
      }),
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: ["issues", projectId] });
      qc.setQueryData(["issue", projectId, updated.id], updated);
    },
  });
}

// Explore --------------------------------------------------------------------

export type ResourceAttr = {
  key: string;
  value: string;
  op?: "eq" | "neq" | "not_contains";
};

export type ExploreRange = { since: string; until: string };

export type ExploreFilter = {
  range: ExploreRange;
  service?: string;
  resourceAttrs?: ResourceAttr[];
  search?: string;
  severity?: string;
  spanName?: string;
  statusCode?: string;
  minDurationMs?: number;
};

export type LogRow = {
  timestamp: string;
  service: string;
  severity: string;
  severity_number: number;
  body: string;
  trace_id: string;
  span_id: string;
  log_attrs: Record<string, string>;
  resource_attrs: Record<string, string>;
};

export type TraceRow = {
  timestamp: string;
  trace_id: string;
  span_id: string;
  parent_span_id: string;
  service: string;
  span_name: string;
  span_kind: string;
  status_code: string;
  status_message: string;
  duration_ms: number;
};

export type TraceAggregatedRow = {
  trace_id: string;
  start_time: string;
  root_span_name: string;
  root_service: string;
  root_status_code: string;
  span_count: number;
  error_count: number;
  service_count: number;
  duration_ms: number;
};

export type TraceSpan = {
  timestamp: string;
  start_ns: string;
  trace_id: string;
  span_id: string;
  parent_span_id: string;
  service: string;
  span_name: string;
  span_kind: string;
  status_code: string;
  status_message: string;
  duration_ns: string;
  duration_ms: number;
  span_attrs: Record<string, string>;
  resource_attrs: Record<string, string>;
};

export type TraceLog = {
  timestamp: string;
  ts_ns: string;
  service: string;
  severity: string;
  body: string;
  trace_id: string;
  span_id: string;
  log_attrs: Record<string, string>;
};

export type TraceDetailResponse = { spans: TraceSpan[]; logs: TraceLog[] };

export type SeriesRow = { bucket: string; group: string; count: number };

export type AttributeKey = { key: string; count: number };
export type AttributeValue = { value: string; count: number };

export type MetricName = { name: string; kind: string; unit: string };
export type MetricRow = {
  timestamp: string;
  kind: string;
  metric_name: string;
  unit: string;
  service: string;
  value: number | null;
  count: number | null;
};
export type MetricSeriesRow = { bucket: string; group: string; value: number };

export function useExploreAttributeKeys(projectId: string | undefined, range: ExploreRange) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["explore", "attribute-keys", projectId, range.since, range.until],
    queryFn: () =>
      fetcher<AttributeKey[]>(
        `/api/projects/${projectId}/explore/attribute-keys?since=${encodeURIComponent(
          range.since,
        )}&until=${encodeURIComponent(range.until)}`,
      ),
    enabled: !!projectId,
  });
}

export function useExploreAttributeValues(
  projectId: string | undefined,
  key: string | undefined,
  range: ExploreRange,
) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["explore", "attribute-values", projectId, key, range.since, range.until],
    queryFn: () => {
      if (!projectId || !key) return Promise.resolve([]);
      return fetcher<AttributeValue[]>(
        `/api/projects/${projectId}/explore/attribute-values?key=${encodeURIComponent(
          key,
        )}&since=${encodeURIComponent(range.since)}&until=${encodeURIComponent(range.until)}`,
      );
    },
    enabled: !!projectId && !!key,
  });
}

export function useExploreLogs(
  projectId: string | undefined,
  filter: ExploreFilter,
  limit: number,
) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["explore", "logs", projectId, filter, limit],
    queryFn: () =>
      fetcher<LogRow[]>(`/api/projects/${projectId}/explore/logs`, {
        method: "POST",
        body: JSON.stringify({ ...filter, limit }),
      }),
    enabled: !!projectId,
  });
}

export function useExploreTraces(
  projectId: string | undefined,
  filter: ExploreFilter,
  limit: number,
) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["explore", "traces", projectId, filter, limit],
    queryFn: () =>
      fetcher<TraceRow[]>(`/api/projects/${projectId}/explore/traces`, {
        method: "POST",
        body: JSON.stringify({ ...filter, limit }),
      }),
    enabled: !!projectId,
  });
}

export function useExploreTracesAggregated(
  projectId: string | undefined,
  filter: ExploreFilter,
  limit: number,
) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["explore", "traces-aggregated", projectId, filter, limit],
    queryFn: () =>
      fetcher<TraceAggregatedRow[]>(`/api/projects/${projectId}/explore/traces-aggregated`, {
        method: "POST",
        body: JSON.stringify({ ...filter, limit }),
      }),
    enabled: !!projectId && limit > 0,
  });
}

export function useTraceDetail(projectId: string | undefined, traceId: string | undefined) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["trace-detail", projectId, traceId],
    queryFn: () =>
      fetcher<TraceDetailResponse>(`/api/projects/${projectId}/explore/traces/${traceId}`),
    enabled: !!projectId && !!traceId,
  });
}

export function useExploreMetricNames(projectId: string | undefined, range: ExploreRange) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["explore", "metric-names", projectId, range.since, range.until],
    queryFn: () =>
      fetcher<MetricName[]>(
        `/api/projects/${projectId}/explore/metric-names?since=${encodeURIComponent(
          range.since,
        )}&until=${encodeURIComponent(range.until)}`,
      ),
    enabled: !!projectId,
  });
}

export const METRIC_AGGREGATIONS = ["sum", "avg", "min", "max", "p95", "p99"] as const;
export type MetricAggregation = (typeof METRIC_AGGREGATIONS)[number];

export function useExploreMetricSeries(
  projectId: string | undefined,
  metricName: string | undefined,
  filter: ExploreFilter,
  groupBy: string | undefined,
  aggregation?: MetricAggregation,
) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: [
      "explore",
      "metric-series",
      projectId,
      metricName,
      filter,
      groupBy ?? "",
      aggregation ?? "",
    ],
    queryFn: () =>
      fetcher<{ step: string; rows: MetricSeriesRow[] }>(
        `/api/projects/${projectId}/explore/metric-series`,
        {
          method: "POST",
          body: JSON.stringify({
            metricName,
            groupBy: groupBy ?? "",
            aggregation: aggregation ?? "",
            filter,
          }),
        },
      ),
    enabled: !!projectId && !!metricName,
  });
}

export function useExploreMetrics(
  projectId: string | undefined,
  filter: ExploreFilter,
  metricName: string | undefined,
  limit: number,
) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["explore", "metrics", projectId, metricName, filter, limit],
    queryFn: () =>
      fetcher<MetricRow[]>(`/api/projects/${projectId}/explore/metrics`, {
        method: "POST",
        body: JSON.stringify({ ...filter, metricName, limit }),
      }),
    enabled: !!projectId && limit > 0,
  });
}

export function useExploreSeries(
  projectId: string | undefined,
  source: "logs" | "traces",
  filter: ExploreFilter,
  groupBy: string | undefined,
) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["explore", "series", projectId, source, filter, groupBy ?? ""],
    queryFn: () =>
      fetcher<{ step: string; rows: SeriesRow[] }>(`/api/projects/${projectId}/explore/series`, {
        method: "POST",
        body: JSON.stringify({ source, groupBy: groupBy ?? "", filter }),
      }),
    enabled: !!projectId,
  });
}
