import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "./api-error.ts";
import { incidentPollIntervalMs } from "./incidents/agent-run-polling.ts";
import type { SavedExploreViewState } from "./saved-view-state.ts";

const API_URL = import.meta.env?.VITE_API_URL ?? "http://localhost:4100";

export function apiRequestUrl(path: string, apiUrl = API_URL): string {
	if (/^https?:\/\//i.test(path)) return path;
	return `${apiUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

export type Me = {
  user: { id: string; email: string; name: string; isStaff: boolean; impersonating: boolean };
  // Both null when the user signed up but hasn't created their first org yet.
  // The onboarding wizard's create-org step posts to /api/me/orgs to fix that.
  org: { id: string; name: string; slug: string; githubSetupNeeded: boolean } | null;
  project: { id: string; name: string; slug: string; hasIngested: boolean } | null;
  // True when a shared demo project is configured and this project hasn't
  // ingested yet — the server is serving it read-only sample data. Drives the
  // demo-explore experience + the persistent install nudge. Flips false the
  // instant real telemetry lands (hasIngested), teleporting the user to their
  // own project.
  demoMode?: boolean;
  // The user's pinned favorite project + its org. When set, a fresh session
  // opens these instead of the last-used org/project. Both null when nothing is
  // pinned. Driven by the ★ in the org/project switcher.
  favorite?: { orgId: string | null; projectId: string | null };
  // Whether billing hard-blocks are enforced. Metering runs regardless; this
  // gates the "Ingest paused" bar so we don't show it when nothing is blocked.
  billingEnforcement?: boolean;
  features?: { anomalyScanner: boolean };
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
  cloudflareConnect: boolean;
  vercelConnect: boolean;
  railwayConnect: boolean;
  renderConnect: boolean;
  gcpConnect: boolean;
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

export function useFetcher() {
  return async function fetcher<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      ...((init.headers as Record<string, string> | undefined) ?? {}),
      "content-type": "application/json",
    };
    if (path === "/api/me") {
      const source = readPendingSignupSource();
      if (source) headers["x-superlog-signup-source"] = source;
    }
    const res = await fetch(apiRequestUrl(path), {
      ...init,
      credentials: "include",
      headers,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new ApiError(res.status, body);
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
    // Poll while the active project hasn't ingested yet, then stop. This is what
    // makes the onboarding gate teleport off the install wizard / demo data the
    // instant real telemetry lands (hasIngested is derived from the proxy's
    // project-level acceptance marker), and the onboarding flows key their
    // "first events" state off the same field. Post-ingest (the common case)
    // there's no polling.
    refetchInterval: (query) => (query.state.data?.project?.hasIngested ? false : 10_000),
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
    // The signup / org-created events are emitted server-side now (see the API's
    // user-create hook and /api/me/orgs), so the client just refreshes state.
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });
}

// Create an additional organization (the caller already has one). Callers
// switch the active org to the new one and then invalidate ["me"] /
// ["org-projects"] — so invalidation lives at the call site (after setActive),
// not here, to avoid a premature refetch against the old active org.
export function useCreateOrg() {
  const fetcher = useFetcher();
  return useMutation({
    mutationFn: (name: string) =>
      fetcher<{
        org: { id: string; name: string; slug: string };
        project: { id: string; name: string; slug: string };
      }>("/api/orgs", { method: "POST", body: JSON.stringify({ name }) }),
  });
}

// Delete an organization (owner-only, and never the caller's last org — both
// enforced server-side). Callers setActive() to a remaining org first and then
// invalidate the org-scoped queries, so invalidation lives at the call site.
export function useDeleteOrg() {
  const fetcher = useFetcher();
  return useMutation({
    mutationFn: (orgId: string) =>
      fetcher<{ ok: true }>(`/api/orgs/${orgId}`, { method: "DELETE" }),
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

// Staff-only user picker that backs the impersonation command-palette flow.
// This endpoint only returns enough to find a user.
export type ImpersonationTarget = {
  userId: string;
  email: string;
  name: string | null;
  orgs: { name: string; slug: string }[];
};

export function useImpersonationTargets(enabled: boolean, query: string) {
  const fetcher = useFetcher();
  const q = query.trim();
  const path =
    q.length > 0
      ? `/api/admin/impersonation-targets?q=${encodeURIComponent(q)}`
      : "/api/admin/impersonation-targets";
  return useQuery({
    queryKey: ["impersonation-targets", q],
    queryFn: () => fetcher<{ users: ImpersonationTarget[]; limit: number }>(path),
    enabled,
  });
}

// --- Feedback ---

export function useSubmitFeedback() {
  const fetcher = useFetcher();
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
  });
}

// Anonymous PR-link submissions go to a different (public) endpoint that
// doesn't require credentials, so we use plain fetch instead of the
// cookie-bearing useFetcher.
const API_URL_FOR_FEEDBACK = import.meta.env?.VITE_API_URL ?? "http://localhost:4100";
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
    mutationFn: (body: { url: string; description?: string; enabledEvents?: string[] }) =>
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
    mutationFn: (vars: {
      id: string;
      url?: string;
      description?: string;
      disabled?: boolean;
      enabledEvents?: string[];
    }) =>
      fetcher<WebhookEndpoint>(`/api/projects/${projectId}/webhooks/${vars.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          url: vars.url,
          description: vars.description,
          disabled: vars.disabled,
          enabledEvents: vars.enabledEvents,
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

// User-scoped personal access tokens (superlog_pat_*). An alternative to the
// browser OAuth flow for authenticating to the MCP server — paste one as a
// static `Authorization: Bearer` header in your agent's MCP config.
export type McpExpiryChoice = "never" | "30d" | "90d";

export type McpToken = {
  id: string;
  name: string;
  tokenPrefix: string;
  projectId: string;
  projectName: string | null;
  orgName: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

export type MintedMcpToken = {
  id: string;
  name: string;
  tokenPrefix: string;
  plaintext: string;
  projectId: string;
  expiresAt: string | null;
  createdAt: string;
};

export function useMcpTokens() {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["mcp-tokens"],
    queryFn: () => fetcher<{ tokens: McpToken[] }>("/api/me/mcp-tokens"),
  });
}

export function useCreateMcpToken() {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; projectId?: string; expiry: McpExpiryChoice }) =>
      fetcher<{ token: MintedMcpToken }>("/api/me/mcp-tokens", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mcp-tokens"] }),
  });
}

export function useRevokeMcpToken() {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tokenId: string) =>
      fetcher<{ ok: true }>(`/api/me/mcp-tokens/${tokenId}`, {
        method: "DELETE",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mcp-tokens"] }),
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

export type RepoBranch = { name: string; isDefault: boolean };

// Branches the agent can target for PRs, fetched live from the project's
// connected GitHub repos. Used by the PR-target-branch picker in Settings.
export function useGithubBranches(projectId: string | undefined, enabled: boolean) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["github-branches", projectId],
    queryFn: () =>
      fetcher<{ branches: RepoBranch[] }>(`/api/projects/${projectId}/github/branches`),
    enabled: enabled && !!projectId,
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

export function slackProjectEndpoints(projectId: string) {
  const base = `/api/projects/${encodeURIComponent(projectId)}/slack`;
  return {
    installation: `${base}/installation`,
    installUrl: `${base}/install-url`,
    uninstall: `${base}/uninstall`,
    channels: `${base}/channels`,
  };
}

function slackEndpoints(projectId?: string) {
  return projectId
    ? slackProjectEndpoints(projectId)
    : {
        installation: "/api/slack/installation",
        installUrl: "/api/slack/install-url",
        uninstall: "/api/slack/uninstall",
        channels: "/api/slack/channels",
      };
}

export function useSlackInstallation(projectId?: string, enabled = true) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["slack-installation", projectId ?? "active"],
    queryFn: () => fetcher<SlackInstallation>(slackEndpoints(projectId).installation),
    enabled,
    // Poll like the github query so the setup stepper picks up OAuth
    // completion without a manual refresh.
    refetchInterval: 15000,
  });
}

export function useStartSlackInstall(projectId?: string) {
  const fetcher = useFetcher();
  return useMutation({
    mutationFn: () =>
      fetcher<{ url: string }>(slackEndpoints(projectId).installUrl, { method: "POST" }),
  });
}

export function useUninstallSlack(projectId?: string) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      fetcher<{ ok: true }>(slackEndpoints(projectId).uninstall, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["slack-installation", projectId ?? "active"] });
      qc.invalidateQueries({ queryKey: ["slack-channels", projectId ?? "active"] });
    },
  });
}

export type CloudflareInstallation =
  | { installed: false }
  | {
      installed: true;
      accountId: string;
      accountName: string | null;
      scope: string | null;
      destinations: Record<string, string>;
      autoWire: boolean;
      installedAt: string;
    };

// Cloudflare installs are per-project, so every hook is scoped by projectId —
// the query key includes it so switching projects refetches the right state
// instead of briefly showing another project's connected account.
export function useCloudflareInstallation(projectId: string | undefined) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["cloudflare-installation", projectId],
    queryFn: () =>
      fetcher<CloudflareInstallation>(`/api/projects/${projectId}/cloudflare/installation`),
    enabled: !!projectId,
    // Poll so the card flips to "connected" after the OAuth redirect without a
    // manual refresh (same pattern as Slack/GitHub).
    refetchInterval: 15000,
  });
}

export function useStartCloudflareInstall(projectId: string | undefined) {
  const fetcher = useFetcher();
  return useMutation({
    mutationFn: () =>
      fetcher<{ url: string }>(`/api/projects/${projectId}/cloudflare/install-url`, {
        method: "POST",
      }),
  });
}

export function useUninstallCloudflare(projectId: string | undefined) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      fetcher<{ ok: true }>(`/api/projects/${projectId}/cloudflare/uninstall`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cloudflare-installation", projectId] });
    },
  });
}

export type CloudflareWorker = { name: string; wired: boolean; observabilityEnabled: boolean };

// The account's Worker scripts and whether each currently exports to us. Only
// fetched when connected (pass `enabled`), since it hits the Cloudflare API.
// Keyed by accountId as well as projectId so a same-project reconnect to a
// different Cloudflare account can't momentarily show the previous account's
// workers from cache. Mutations invalidate by the ["cloudflare-workers",
// projectId] prefix, which still matches this longer key.
export function useCloudflareWorkers(
  projectId: string | undefined,
  accountId: string | undefined,
  enabled: boolean,
) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["cloudflare-workers", projectId, accountId],
    queryFn: () =>
      fetcher<{ workers: CloudflareWorker[] }>(`/api/projects/${projectId}/cloudflare/workers`),
    enabled: !!projectId && !!accountId && enabled,
  });
}

function useCloudflareWorkerAction(projectId: string | undefined, action: "wire" | "unwire") {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (script: string) =>
      fetcher<{ ok: true; wired: boolean }>(
        `/api/projects/${projectId}/cloudflare/workers/${encodeURIComponent(script)}/${action}`,
        { method: "POST" },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cloudflare-workers", projectId] });
    },
  });
}

export function useWireCloudflareWorker(projectId: string | undefined) {
  return useCloudflareWorkerAction(projectId, "wire");
}

export function useUnwireCloudflareWorker(projectId: string | undefined) {
  return useCloudflareWorkerAction(projectId, "unwire");
}

export function useWireAllCloudflareWorkers(projectId: string | undefined) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      fetcher<{ ok: true; scripts: number; wired: number }>(
        `/api/projects/${projectId}/cloudflare/workers/wire-all`,
        { method: "POST" },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cloudflare-workers", projectId] });
    },
  });
}

// Toggle auto-wire. Enabling also runs an immediate wire pass server-side, so
// refresh both the installation (autoWire flag) and the workers list on success.
export function useSetCloudflareAutoWire(projectId: string | undefined) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (autoWire: boolean) =>
      fetcher<{ ok: true; autoWire: boolean }>(`/api/projects/${projectId}/cloudflare/auto-wire`, {
        method: "POST",
        body: JSON.stringify({ autoWire }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cloudflare-installation", projectId] });
      qc.invalidateQueries({ queryKey: ["cloudflare-workers", projectId] });
    },
  });
}

export type VercelInstallation =
  | { installed: false }
  | {
      installed: true;
      teamId: string;
      teamName: string | null;
      configurationId: string;
      drains: Record<string, string>;
      installedAt: string;
    };

// Vercel installs are per-project, so every hook is scoped by projectId — the
// query key includes it so switching projects refetches the right state instead
// of briefly showing another project's connected team.
export function useVercelInstallation(projectId: string | undefined) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["vercel-installation", projectId],
    queryFn: () => fetcher<VercelInstallation>(`/api/projects/${projectId}/vercel/installation`),
    enabled: !!projectId,
    // Poll so the card flips to "connected" after the OAuth redirect without a
    // manual refresh (same pattern as Slack/GitHub/Cloudflare).
    refetchInterval: 15000,
  });
}

export function useStartVercelInstall(projectId: string | undefined) {
  const fetcher = useFetcher();
  return useMutation({
    mutationFn: () =>
      fetcher<{ url: string }>(`/api/projects/${projectId}/vercel/install-url`, {
        method: "POST",
      }),
  });
}

export function useUninstallVercel(projectId: string | undefined) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      fetcher<{ ok: true }>(`/api/projects/${projectId}/vercel/uninstall`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["vercel-installation", projectId] });
    },
  });
}

export type RailwayInstallation =
  | { installed: false }
  | {
      installed: true;
      railwayUserId: string;
      grantedProjects: Array<{
        id: string;
        name: string;
        workspaceId: string | null;
        workspaceName: string | null;
      }>;
      scope: string | null;
      installedAt: string;
    };

// Railway installs are per-project, same scoping discipline as Vercel.
export function useRailwayInstallation(projectId: string | undefined) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["railway-installation", projectId],
    queryFn: () => fetcher<RailwayInstallation>(`/api/projects/${projectId}/railway/installation`),
    enabled: !!projectId,
    // Poll so the card flips to "connected" after the OAuth redirect without a
    // manual refresh (same pattern as Slack/GitHub/Cloudflare/Vercel).
    refetchInterval: 15000,
  });
}

export function useStartRailwayInstall(projectId: string | undefined) {
  const fetcher = useFetcher();
  return useMutation({
    mutationFn: () =>
      fetcher<{ url: string }>(`/api/projects/${projectId}/railway/install-url`, {
        method: "POST",
      }),
  });
}

export function useUninstallRailway(projectId: string | undefined) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      fetcher<{ ok: true }>(`/api/projects/${projectId}/railway/uninstall`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["railway-installation", projectId] });
    },
  });
}

export type GcpConnection =
  | { connected: false }
  | {
      connected: boolean;
      id: string;
      projectId: string;
      gcpProjectId: string;
      gcpProjectNumber: string | null;
      status: "pending" | "provisioning" | "connected" | "failed";
      lastVerifiedAt: string | null;
      lastLogReceivedAt: string | null;
      lastMetricsReceivedAt: string | null;
      metricsBudgetMonth: string | null;
      metricsSeriesRead: number;
      metricsMonthlySeriesLimit: number;
      lastError: string | null;
      createdAt: string;
      updatedAt: string;
    };

export function useGcpConnection(projectId: string | undefined) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["gcp-connection", projectId],
    queryFn: () => fetcher<GcpConnection>(`/api/projects/${projectId}/gcp/connection`),
    enabled: !!projectId,
    refetchInterval: 15_000,
  });
}

export function useStartGcpConnect(projectId: string | undefined) {
  const fetcher = useFetcher();
  return useMutation({
    mutationFn: () =>
      fetcher<{ url: string }>(`/api/projects/${projectId}/gcp/install-url`, {
        method: "POST",
      }),
  });
}

export type GcpProjectOption = {
  projectId: string;
  projectNumber: string;
  displayName: string;
};

export type GcpAuthorizationSelection = {
  id: string;
  expiresAt: string;
  projects: GcpProjectOption[];
};

export function useGcpAuthorizationSelection(authorizationId: string | null) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["gcp-authorization", authorizationId],
    queryFn: () => fetcher<GcpAuthorizationSelection>(`/api/gcp/authorizations/${authorizationId}`),
    enabled: !!authorizationId,
    retry: false,
  });
}

export function useConnectGcpAuthorization(authorizationId: string | null) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (gcpProjectId: string) =>
      fetcher<{ connected: true }>(`/api/gcp/authorizations/${authorizationId}/connect`, {
        method: "POST",
        body: JSON.stringify({ gcpProjectId }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["gcp-connection"] });
      qc.removeQueries({ queryKey: ["gcp-authorization", authorizationId] });
    },
  });
}

export type RenderServiceSummary = {
  id: string;
  name: string;
  type: string;
  region: string | null;
  suspended: boolean;
};

export type RenderStreamState = {
  status: "provisioned" | "conflict" | "unavailable";
  endpoint: string | null;
  detail: string | null;
} | null;

export type RenderInstallation =
  | { installed: false }
  | {
      installed: true;
      ownerId: string;
      ownerName: string | null;
      services: RenderServiceSummary[];
      // How each signal arrives: "provisioned" = Render pushes it to our
      // intake (log/metrics stream); anything else = the worker polls
      // Render's API as a fallback.
      logStream: RenderStreamState;
      metricsStream: RenderStreamState;
      installedAt: string;
    };

export type RenderOwner = {
  id: string;
  name: string;
  email: string | null;
  type: string;
};

// Render installs are per-project, same scoping discipline as Railway.
export function useRenderInstallation(projectId: string | undefined) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["render-installation", projectId],
    queryFn: () => fetcher<RenderInstallation>(`/api/projects/${projectId}/render/installation`),
    enabled: !!projectId,
    refetchInterval: 15000,
  });
}

// Validate a pasted Render API key and list the workspaces it can see — the
// connect dialog's picker step. The key is only held in memory client-side.
export function useRenderOwners(projectId: string | undefined) {
  const fetcher = useFetcher();
  return useMutation({
    mutationFn: (apiKey: string) =>
      fetcher<{ owners: RenderOwner[] }>(`/api/projects/${projectId}/render/owners`, {
        method: "POST",
        body: JSON.stringify({ apiKey }),
      }),
  });
}

export function useConnectRender(projectId: string | undefined) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { apiKey: string; ownerId: string }) =>
      fetcher<RenderInstallation>(`/api/projects/${projectId}/render/connect`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["render-installation", projectId] });
    },
  });
}

export function useUninstallRender(projectId: string | undefined) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      fetcher<{ ok: true }>(`/api/projects/${projectId}/render/uninstall`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["render-installation", projectId] });
    },
  });
}

export function useSlackChannels(enabled: boolean, projectId?: string) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["slack-channels", projectId ?? "active"],
    queryFn: () => fetcher<{ channels: SlackChannel[] }>(slackEndpoints(projectId).channels),
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

export type CloudConnectionStatus = "pending" | "connected" | "account_mismatch" | "failed";

export type CloudConnection = {
  id: string;
  projectId: string;
  region: string;
  scrapeRoleArn: string | null;
  accountId: string | null;
  status: CloudConnectionStatus;
  lastVerifiedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

// The create response also returns the one-time launch URL + external id.
export type CreatedCloudConnection = CloudConnection & {
  launchUrl: string;
  externalId: string;
};

export function useCloudConnections(projectId: string | undefined) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["cloud-connections", projectId],
    queryFn: () => fetcher<CloudConnection[]>(`/api/projects/${projectId}/cloud-connections`),
    enabled: !!projectId,
    // While a connection is pending, poll so zero-paste connects (the stack
    // reports its role back via the callback) flip to Connected on their own.
    refetchInterval: (query) => {
      const rows = query.state.data as CloudConnection[] | undefined;
      return rows?.some((r) => r.status === "pending") ? 4000 : false;
    },
  });
}

export function useCreateCloudConnection(projectId: string) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { region: string }) =>
      fetcher<CreatedCloudConnection>(`/api/projects/${projectId}/cloud-connections`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cloud-connections", projectId] }),
  });
}

export function useVerifyCloudConnection(projectId: string) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; scrapeRoleArn: string }) =>
      fetcher<CloudConnection>(`/api/projects/${projectId}/cloud-connections/${input.id}/verify`, {
        method: "POST",
        body: JSON.stringify({ scrapeRoleArn: input.scrapeRoleArn }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cloud-connections", projectId] }),
  });
}

export type StackComponentState = "missing" | "pending" | "working" | "broken";
export type StackComponentKey = "connection" | "metrics" | "logs";
export type StackComponent = {
  key: StackComponentKey;
  label: string;
  state: StackComponentState;
  detail: string;
  lastReceivedAt: string | null;
};
export type CloudStackHealth = { components: StackComponent[] };

// Reconciliation health for a connection's stack (connection / metrics / logs).
// Polls so the live "last received" + working/quiet signals stay fresh.
export function useCloudStackHealth(
  projectId: string | undefined,
  connectionId: string | undefined,
  enabled: boolean,
) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["cloud-stack-health", projectId, connectionId],
    queryFn: () =>
      fetcher<CloudStackHealth>(
        `/api/projects/${projectId}/cloud-connections/${connectionId}/stack-health`,
      ),
    enabled: !!projectId && !!connectionId && enabled,
    refetchInterval: 15000,
  });
}

// Set up (or idempotently re-launch) metric or log streaming: returns the
// CloudFormation launch URL for the corresponding stack, reusing the stream's
// persisted ingest key on repeat calls.
export function useSetupCloudStream(projectId: string) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { connectionId: string; kind: "metrics" | "logs" }) =>
      fetcher<{ launchUrl: string; keyPrefix: string }>(
        `/api/projects/${projectId}/cloud-connections/${input.connectionId}/${input.kind}-stream`,
        { method: "POST" },
      ),
    onSuccess: (_data, vars) =>
      qc.invalidateQueries({ queryKey: ["cloud-stack-health", projectId, vars.connectionId] }),
  });
}

export type CloudResourceRow = {
  id: string;
  connectionId: string;
  arn: string;
  service: string;
  resourceType: string | null;
  region: string | null;
  accountId: string | null;
  name: string | null;
  tags: Record<string, string> | null;
  lastSeenAt: string;
};

export function useCloudResources(projectId: string | undefined) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["cloud-resources", projectId],
    queryFn: () => fetcher<CloudResourceRow[]>(`/api/projects/${projectId}/cloud-resources`),
    enabled: !!projectId,
  });
}

// Trigger an inventory sweep for one connection; resources list invalidates after.
export function useSyncCloudConnection(projectId: string) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (connectionId: string) =>
      fetcher<{ discovered: number; removed: number }>(
        `/api/projects/${projectId}/cloud-connections/${connectionId}/sync`,
        { method: "POST" },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cloud-resources", projectId] }),
  });
}

export function useDeleteCloudConnection(projectId: string) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      fetcher<{ ok: true }>(`/api/projects/${projectId}/cloud-connections/${id}`, {
        method: "DELETE",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cloud-connections", projectId] }),
  });
}

// Per-project ingest source filters: turn a telemetry source (SDK/OTLP, AWS
// CloudWatch, Vercel Drains, or the Railway/Render pullers) on/off per signal.
// The proxy ack-drops disabled telemetry.
export type IngestFilterState = {
  otlp: { traces: boolean; logs: boolean; metrics: boolean };
  aws: { logs: boolean; metrics: boolean };
  gcp: { logs: boolean; metrics: boolean };
  vercel: { traces: boolean; logs: boolean };
  railway: { logs: boolean; metrics: boolean };
  render: { logs: boolean; metrics: boolean };
};

export function useIngestFilters(projectId: string | undefined) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["ingest-filters", projectId],
    enabled: !!projectId,
    queryFn: () => fetcher<IngestFilterState>(`/api/projects/${projectId}/ingest-filters`),
  });
}

export function useSetIngestFilters(projectId: string) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (state: IngestFilterState) =>
      fetcher<IngestFilterState>(`/api/projects/${projectId}/ingest-filters`, {
        method: "PUT",
        body: JSON.stringify(state),
      }),
    onSuccess: (data) => qc.setQueryData(["ingest-filters", projectId], data),
  });
}

// --- Service map / topology -------------------------------------------------

export type TopologyDoc = {
  status: "empty" | "idle" | "generating" | "error";
  graph: import("@superlog/topology").Topology | null;
  enrichment: import("@superlog/topology").TopologyEnrichment | null;
  generatedAt: string | null;
  error?: string | null;
};

export function useTopology(projectId: string | undefined) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["topology", projectId],
    enabled: !!projectId,
    queryFn: () => fetcher<TopologyDoc>(`/api/projects/${projectId}/topology`),
    // While a build is in flight, poll so the map appears when it lands.
    refetchInterval: (q) => (q.state.data?.status === "generating" ? 4000 : false),
  });
}

export function useGenerateTopology(projectId: string) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      fetcher<{ status: string }>(`/api/projects/${projectId}/topology/generate`, {
        method: "POST",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["topology", projectId] }),
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

export type NotionInstallation =
  | { installed: false }
  | {
      installed: true;
      workspaceId: string;
      workspaceName: string | null;
      workspaceIcon: string | null;
      actorEmail: string | null;
      needsReauth: boolean;
      reauthReason: string | null;
      reauthRequiredAt: string | null;
    };

export function useNotionInstallation() {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["notion-installation"],
    queryFn: () => fetcher<NotionInstallation>("/api/notion/installation"),
  });
}

export function useStartNotionInstall() {
  const fetcher = useFetcher();
  return useMutation({
    mutationFn: () => fetcher<{ url: string }>("/api/notion/install-url", { method: "POST" }),
  });
}

export function useUninstallNotion() {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => fetcher<{ ok: true }>("/api/notion/uninstall", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notion-installation"] }),
  });
}

export type OrgProject = { id: string; name: string; slug: string; projectContext: string };

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
      patch: { name?: string; slug?: string; projectContext?: string };
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

export function useSetActiveContext() {
  const fetcher = useFetcher();
  return useMutation({
    mutationFn: (input: { orgSlug: string; projectSlug: string }) =>
      fetcher<{
        org: { id: string; name: string; slug: string };
        project: { id: string; name: string; slug: string };
      }>("/api/me/active-context", {
        method: "PUT",
        body: JSON.stringify(input),
      }),
  });
}

// Pin a project as the favorite (opens by default on a fresh session), or pass
// null to clear the favorite. The server pins the active org alongside it.
export function useSetFavoriteProject() {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string | null) =>
      fetcher<{ favorite: { orgId: string | null; projectId: string | null } }>(
        "/api/me/favorite",
        { method: "PUT", body: JSON.stringify({ projectId }) },
      ),
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
  approvalPromptsEnabled: boolean;
  createLinearTicketOnResolve: boolean;
  prBaseBranch: string | null;
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

export type ProjectMcpServerAuthView =
  | { type: "none"; hasCredential: false }
  | { type: "bearer"; hasCredential: true }
  | { type: "api_key"; hasCredential: true; headerName: string }
  | {
      type: "oauth";
      grantType: "authorization_code" | "client_credentials";
      hasCredential: boolean;
      status: "pending" | "connected" | "error";
      scopes: string[];
      expiresAt: string | null;
    };

export type ProjectMcpServer = {
  id: string;
  projectId: string;
  name: string;
  url: string;
  enabled: boolean;
  auth: ProjectMcpServerAuthView;
  trustedByUserId: string | null;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  trustedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type ProjectMcpAuthInput =
  | { type: "none" }
  | { type: "bearer"; token: string }
  | { type: "api_key"; headerName: string; key: string }
  | {
      type: "oauth";
      grantType: "authorization_code" | "client_credentials";
      scopes: string[];
      clientId?: string;
      clientSecret?: string;
    };

export type ProjectMcpServerList = {
  servers: ProjectMcpServer[];
  enabledCount: number;
  enabledLimit: number;
  canManage: boolean;
};

const projectMcpQueryKey = (projectId: string | undefined) => ["project-agent-mcps", projectId];

export function useProjectMcpServers(projectId: string | undefined) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: projectMcpQueryKey(projectId),
    queryFn: () =>
      fetcher<ProjectMcpServerList>(`/api/org/projects/${projectId}/agent-mcp-servers`),
    enabled: !!projectId,
  });
}

export function useCreateProjectMcpServer(projectId: string | undefined) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      name: string;
      url: string;
      enabled?: boolean;
      auth: ProjectMcpAuthInput;
      confirmTrusted: boolean;
    }) =>
      fetcher<{ server: ProjectMcpServer }>(
        `/api/org/projects/${requireProjectId(projectId)}/agent-mcp-servers`,
        { method: "POST", body: JSON.stringify(input) },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: projectMcpQueryKey(projectId) }),
  });
}

export function useUpdateProjectMcpServer(projectId: string | undefined) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string } & Record<string, unknown>) =>
      fetcher<{ server: ProjectMcpServer }>(
        `/api/org/projects/${requireProjectId(projectId)}/agent-mcp-servers/${id}`,
        { method: "PATCH", body: JSON.stringify(patch) },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: projectMcpQueryKey(projectId) }),
  });
}

export function useDeleteProjectMcpServer(projectId: string | undefined) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      fetcher<{ ok: true }>(
        `/api/org/projects/${requireProjectId(projectId)}/agent-mcp-servers/${id}`,
        { method: "DELETE" },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: projectMcpQueryKey(projectId) }),
  });
}

export function useTestProjectMcpServer(projectId: string | undefined) {
  const fetcher = useFetcher();
  return useMutation({
    mutationFn: (id: string) =>
      fetcher<{ toolCount: number; tools: string[] }>(
        `/api/org/projects/${requireProjectId(projectId)}/agent-mcp-servers/${id}/test`,
        { method: "POST" },
      ),
  });
}

export function useStartProjectMcpOAuth(projectId: string | undefined) {
  const fetcher = useFetcher();
  return useMutation({
    mutationFn: (id: string) =>
      fetcher<{ authorizationUrl: string; expiresAt: string }>(
        `/api/org/projects/${requireProjectId(projectId)}/agent-mcp-servers/${id}/oauth/start`,
        { method: "POST" },
      ),
  });
}

export function useConnectProjectMcpClientCredentials(projectId: string | undefined) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      fetcher<{ server: ProjectMcpServer }>(
        `/api/org/projects/${requireProjectId(projectId)}/agent-mcp-servers/${id}/oauth/client-credentials`,
        { method: "POST" },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: projectMcpQueryKey(projectId) }),
  });
}

export function useDisconnectProjectMcpOAuth(projectId: string | undefined) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      fetcher<{ ok: true }>(
        `/api/org/projects/${requireProjectId(projectId)}/agent-mcp-servers/${id}/oauth/disconnect`,
        { method: "POST" },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: projectMcpQueryKey(projectId) }),
  });
}

export type AnomalyScannerSettings = {
  enabled: boolean;
  cadenceHours: number;
  observationMinutes: number;
  baselineHours: number;
};

export type AnomalyScanFinding = {
  title: string;
  summary?: string;
  metricName: string;
  service: string | null;
  direction: "spike" | "drop" | "shift";
  dimensions?: Record<string, string>;
  observedValue?: number;
  baselineValue?: number;
  observedSince?: string;
  observedUntil?: string;
  evidence?: string;
  codeEvidence?: Array<{
    repository: string;
    path: string;
    line: number;
    quote: string;
    explanation: string;
  }>;
  incidentOutcome?: "opened" | "deduped";
  issueId: string;
  incidentId: string | null;
};

export type AnomalyScanAudit = {
  version: 1;
  baselineSince: string;
  observedSince: string;
  observedUntil: string;
  metrics: Array<{
    kind: string;
    metricName: string;
    service: string;
    observedCount: number;
    observedAverage: number | null;
    observedMin: number | null;
    observedMax: number | null;
    baselineCount: number;
    baselineAverage: number | null;
    baselineMin: number | null;
    baselineMax: number | null;
  }>;
  repositories: string[];
  alertsCompared: Array<{ id: string; name: string; metricName: string | null }>;
  incidentsCompared: Array<{ id: string; title: string; service: string | null }>;
  decisions: Array<{
    metricName: string;
    service: string | null;
    verdict: "finding" | "rejected";
    reasonCode:
      | "finding"
      | "known_alert"
      | "open_incident"
      | "sparse_data"
      | "counter_behavior"
      | "transient_outlier"
      | "normal_variation"
      | "no_material_impact"
      | "not_code_grounded"
      | "other";
    rationale: string;
    codePaths: Array<{ repository: string; path: string; line: number | null }>;
  }>;
};

export type AnomalyScan = {
  id: string;
  status: "running" | "completed" | "failed";
  metricSeriesScanned: number;
  findingsCount: number;
  incidentsOpened: number;
  incidentsDeduped: number;
  findings: AnomalyScanFinding[];
  audit: AnomalyScanAudit | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
};

export type AnomalyScannerData = {
  settings: AnomalyScannerSettings;
  scans: AnomalyScan[];
};

export function useAnomalyScanner(projectId: string | undefined, featureEnabled: boolean) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["anomaly-scanner", projectId],
    queryFn: () => fetcher<AnomalyScannerData>(`/api/projects/${projectId}/anomaly-scanner`),
    enabled: !!projectId && featureEnabled,
    refetchInterval: (query) =>
      query.state.data?.scans.some((scan) => scan.status === "running") ? 5_000 : false,
  });
}

export function useAnomalyScan(
  projectId: string | undefined,
  scanId: string | undefined,
  featureEnabled: boolean,
) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["anomaly-scanner", projectId, "scan", scanId],
    queryFn: () =>
      fetcher<AnomalyScan>(`/api/projects/${projectId}/anomaly-scanner/scans/${scanId}`),
    enabled: !!projectId && !!scanId && featureEnabled,
    refetchInterval: (query) => (query.state.data?.status === "running" ? 5_000 : false),
  });
}

export function useSaveAnomalyScannerSettings(projectId: string | undefined) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<AnomalyScannerSettings>) =>
      fetcher<AnomalyScannerSettings>(`/api/projects/${projectId}/anomaly-scanner`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["anomaly-scanner", projectId] }),
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

export type AgentMemoryKind = "feedback" | "terminology" | "infra" | "project";

export type AgentMemory = {
  id: string;
  kind: AgentMemoryKind;
  projectId: string;
  title: string;
  body: string;
  status: "active" | "archived";
  source: "agent" | "user" | null;
  createdAt: string;
  updatedAt: string;
};

export function useProjectAgentMemories(projectId: string | undefined) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["project-agent-memories", projectId],
    queryFn: () =>
      fetcher<{ memories: AgentMemory[] }>(`/api/org/projects/${projectId}/agent-memories`),
    enabled: !!projectId,
  });
}

function requireProjectId(projectId: string | undefined): string {
  if (!projectId) throw new Error("No project selected");
  return projectId;
}

export function useCreateProjectAgentMemory(projectId: string | undefined) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { kind: AgentMemoryKind; title: string; body: string }) =>
      fetcher<{ memory: AgentMemory }>(
        `/api/org/projects/${requireProjectId(projectId)}/agent-memories`,
        {
          method: "POST",
          body: JSON.stringify(input),
        },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project-agent-memories", projectId] }),
  });
}

export function useUpdateProjectAgentMemory(projectId: string | undefined) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...patch
    }: {
      id: string;
      kind?: AgentMemoryKind;
      title?: string;
      body?: string;
      status?: "active" | "archived";
    }) =>
      fetcher<{ memory: AgentMemory }>(
        `/api/org/projects/${requireProjectId(projectId)}/agent-memories/${id}`,
        {
          method: "PUT",
          body: JSON.stringify(patch),
        },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project-agent-memories", projectId] }),
  });
}

export function useDeleteProjectAgentMemory(projectId: string | undefined) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      fetcher<{ ok: boolean }>(
        `/api/org/projects/${requireProjectId(projectId)}/agent-memories/${id}`,
        {
          method: "DELETE",
        },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project-agent-memories", projectId] }),
  });
}

export type ProjectDigestSettings = {
  enabled: boolean;
  channelId: string | null;
  channelName: string | null;
  installationId: string | null;
  lastRunAt: string | null;
  runRequestedAt: string | null;
};

export function projectDigestEndpoints(projectId: string) {
  const settings = `/api/projects/${encodeURIComponent(projectId)}/digest`;
  return { settings, runNow: `${settings}/run-now` };
}

export function useProjectDigest(projectId: string | undefined) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["project-digest", projectId],
    queryFn: () =>
      fetcher<ProjectDigestSettings>(projectDigestEndpoints(requireProjectId(projectId)).settings),
    enabled: !!projectId,
    refetchInterval: (query) => (query.state.data?.runRequestedAt ? 2000 : false),
  });
}

export function useSaveProjectDigest(projectId: string | undefined) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: {
      enabled?: boolean;
      channelId?: string | null;
      channelName?: string | null;
    }) =>
      fetcher<ProjectDigestSettings>(projectDigestEndpoints(requireProjectId(projectId)).settings, {
        method: "PUT",
        body: JSON.stringify(patch),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project-digest", projectId] }),
  });
}

export function useRunProjectDigestNow(projectId: string | undefined) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      fetcher<{ ok: true; requestedAt: string }>(
        projectDigestEndpoints(requireProjectId(projectId)).runNow,
        { method: "POST" },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project-digest", projectId] }),
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
  spanAttrs?: Record<string, string> | null;
  logAttrs?: Record<string, string> | null;
  resourceAttrs?: Record<string, string> | null;
};

export type Symbolication = {
  artifact: {
    id: string;
    release: string;
    dist: string | null;
    platform: string;
    debugId: string | null;
  };
  stacktrace: string;
  frames: {
    functionName: string | null;
    source: string;
    line: number;
    column: number;
    generatedFile: string;
    generatedLine: number;
    generatedColumn: number;
  }[];
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
  status: "open" | "silenced" | "under_observation" | "resolved";
  silencedAt: string | null;
  escalationTrigger: { kind: "rate"; perMinute: number } | { kind: "count"; count: number } | null;
  observationStartedAt: string | null;
  eventCount: number;
  groupingState: "grouped" | "pending" | "standalone" | "failed";
  groupingSource: "heuristic" | "llm" | "manual" | null;
  groupingReason: string | null;
  lastSample: IssueSample | null;
  symbolication?: Symbolication | null;
  createdAt: string;
  // Set on the issue-detail response for alert-episode issues: the alert whose
  // breach opened this issue, for the "Triggered by" back-link. Null/absent for
  // ordinary error issues and in list responses.
  triggeringAlert?: { id: string; name: string } | null;
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

export function useLogSymbolication(projectId: string | undefined, log: LogRow | null) {
  const fetcher = useFetcher();
  const stacktrace = log?.log_attrs?.["exception.stacktrace"] ?? null;
  const key = log
    ? {
        stacktrace,
        logAttrs: log.log_attrs,
        resourceAttrs: log.resource_attrs,
      }
    : null;
  return useQuery({
    queryKey: ["log-symbolication", projectId, key],
    queryFn: () =>
      fetcher<{ symbolication: Symbolication | null }>(
        `/api/projects/${projectId}/symbolication/log`,
        {
          method: "POST",
          body: JSON.stringify(key),
        },
      ),
    enabled: !!projectId && !!log && !!stacktrace,
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
  // Legacy fields from the era when propose_pr carried a self-reported
  // validation verdict; current agents no longer send them.
  validationPassed?: boolean;
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

// Why auto-investigation was skipped for this incident, when worth surfacing to
// the user. 'no_credits' = org over its plan's monthly investigation limit.
export type IncidentAutoInvestigateBlockedReason = "no_credits";

// Free-form text explaining why the issue is noise. Previously a closed enum
// (cosmetic_log_only, lifecycle_signal, self_telemetry, expected_third_party,
// confusing_log_no_impact); those values still occur in stored rows and remain
// valid strings — render the text as-is.
export type IncidentNoiseReason = string;

export type IncidentNoiseClassification = {
  reason: IncidentNoiseReason;
  evidence: string;
};

// Free-form text explaining why the incident/issue is considered resolved.
// Previously a closed enum (fixed_in_current_code, transient_condition_cleared,
// upstream_recovered); stored rows may still carry those values.
export type IncidentResolutionReason = string;

export type IncidentResolutionClassification = {
  reason: IncidentResolutionReason;
  evidence: string;
};

export type AgentRunConfidence = {
  text: string;
  confidence: number;
};

// One issue-level verdict recorded by the agent mid-run. The issue row itself
// is the source of truth; this is the run-result record of what was decided
// and why.
export type AgentRunIssueClassification = {
  issueId: string;
  action: "silence" | "observe" | "resolve";
  reason: string;
  evidence: string;
  trigger?: { kind: "rate"; perMinute: number } | { kind: "count"; count: number } | null;
};

// The agent's terminal resolve_incident verdict.
export type AgentRunIncidentResolution = {
  reason: string;
  evidence: string;
};

export type AgentRunResult = {
  state: "complete" | "awaiting_human" | "awaiting_events" | "failed";
  summary: string;
  question?: string | null;
  failureReason?: AgentRunFailureReason | null;
  // Legacy single-PR record (pre multi-PR contract). New runs record every
  // opened PR in `prs`; `pr` is kept pointing at the most recent one for old
  // readers.
  pr?: AgentRunPr | null;
  prs?: AgentRunPr[] | null;
  issueClassifications?: AgentRunIssueClassification[] | null;
  incidentResolution?: AgentRunIncidentResolution | null;
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
  // Deployment environment of the error that opened the incident, denormalized
  // from the triggering issue's telemetry resource attributes. Null when the
  // error carried no `deployment.environment` attribute.
  environment: string | null;
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
  // Why auto-investigation was skipped, when worth surfacing. 'no_credits' = org
  // over its plan's monthly investigation limit. Null when queued or not blocked.
  autoInvestigateBlockedReason: IncidentAutoInvestigateBlockedReason | null;
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
  linearTickets: IncidentLinearTicket[];
  // Timeline events scoped to the latest run, plus PR/Linear ticket events.
  // Empty array when there is no agent run yet.
  timeline: IncidentEvent[];
  // Alert episodes that triggered this incident, for the "Triggered by"
  // back-link. Empty for incidents not raised by an alert.
  alertEpisodes: IncidentAlertEpisode[];
  pendingResolutionProposal: PendingResolutionProposal | null;
};

export type IncidentLinearTicket = {
  id: string;
  agentRunId: string;
  ticketIdentifier: string | null;
  url: string | null;
  state: string | null;
  stateType: "open" | "completed" | "canceled" | "unstarted" | "started" | null;
  createdAt: string;
};

export type IncidentAlertEpisode = {
  id: string;
  alertId: string;
  alertName: string;
  groupKey: string;
  state: "firing" | "resolved";
  startedAt: string;
  endedAt: string | null;
  peakObservedValue: number;
  seq: number;
  // The issue this episode raised. Lets the incident timeline match the
  // triggering issue card to its alert and draw the metric-vs-threshold graph.
  issueId: string | null;
};

export type IncidentPullRequest = {
  id: string;
  agentRunId: string;
  repoFullName: string;
  prNumber: number;
  url: string;
  branchName: string;
  baseBranch: string;
  headSha: string | null;
  state: "open" | "closed" | "merged";
  title: string | null;
  patch: string | null;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
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
    // Poll while the investigation is live so the transcript updates on its own.
    // Re-evaluated each tick against the freshest data, so it stops the moment
    // the run reaches a terminal state.
    refetchInterval: (query) => incidentPollIntervalMs(query.state.data?.agentRun?.state),
  });
}

export type IncidentChatSendResult = {
  ok: true;
  duplicate: boolean;
  action: "resume" | "steer" | "cold_start" | null;
};

// Reasons recordInboundInteraction can decline a chat message (HTTP 409).
const INCIDENT_CHAT_SKIP_MESSAGES: Record<string, string> = {
  agent_runs_disabled: "Agent investigations are disabled for this project.",
  no_prior_run: "There's no investigation to talk to yet — start one first.",
  follow_up_cap_reached: "This incident has reached its follow-up limit.",
  prior_run_too_old: "The last investigation is too old to continue.",
  run_active: "The investigation is busy right now — try again in a moment.",
};

export function incidentChatErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const jsonStart = raw.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const body = JSON.parse(raw.slice(jsonStart)) as { reason?: string; message?: string };
      const key = body.reason ?? body.message;
      if (key && INCIDENT_CHAT_SKIP_MESSAGES[key]) return INCIDENT_CHAT_SKIP_MESSAGES[key];
    } catch {
      // fall through to the raw message
    }
  }
  return `Message failed to send: ${raw}`;
}

export function useSendIncidentChatMessage(projectId: string, incidentId: string) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { text: string; messageId: string }) =>
      fetcher<IncidentChatSendResult>(`/api/projects/${projectId}/incidents/${incidentId}/chat`, {
        method: "POST",
        body: JSON.stringify(vars),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["incident", projectId, incidentId] });
    },
  });
}

export function useIncidentPullRequests(
  projectId: string | undefined,
  incidentId: string | undefined,
  enabled = true,
  // When set, polls at the incident cadence while the run is active so a PR
  // opened mid-run shows up (and surfaces the PR tab) without a refresh.
  agentRunState?: string | null,
) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["incident-prs", projectId, incidentId],
    queryFn: () =>
      fetcher<IncidentPullRequest[]>(
        `/api/projects/${projectId}/incidents/${incidentId}/pull-requests`,
      ),
    enabled: !!projectId && !!incidentId && enabled,
    refetchInterval: incidentPollIntervalMs(agentRunState),
  });
}

// The live PR diff, fetched from GitHub by the API. Used when the PR view has
// no recorded patch body (mid-run `propose_pr` deliveries never record one).
// `headSha` is part of the key: the PR list polls while a run is active and a
// follow-up push moves the head, so the diff refetches exactly when a new
// commit lands — without polling GitHub on a timer.
export function useIncidentPullRequestDiff(path: string, headSha: string | null) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["incident-pr-diff", path, headSha],
    queryFn: () => fetcher<{ patch: string }>(path),
    // Keep showing the previous commit's diff while the new head's loads.
    placeholderData: (prev) => prev,
    staleTime: 60_000,
    retry: 1,
  });
}

export function useMergeIncidentPullRequest(projectId: string, incidentId: string) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { prId: string; method?: "squash" | "merge" | "rebase" }) =>
      fetcher<{ ok: true; sha: string | null; pullRequest: IncidentPullRequest | null }>(
        `/api/projects/${projectId}/incidents/${incidentId}/pull-requests/${vars.prId}/merge`,
        {
          method: "POST",
          body: JSON.stringify({ method: vars.method ?? "squash" }),
        },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["incidents", projectId] });
      qc.invalidateQueries({ queryKey: ["incident", projectId, incidentId] });
      qc.invalidateQueries({ queryKey: ["incident-prs", projectId, incidentId] });
    },
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

// Start a custom investigation from a user-typed prompt. Creates the incident +
// a queued "manual" agent run; returns both so the caller can open the incident.
export function useStartInvestigation(projectId: string) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { prompt: string; service?: string | null; environment?: string | null }) =>
      fetcher<{ incident: Incident; agentRun: AgentRun }>(
        `/api/projects/${projectId}/investigations`,
        { method: "POST", body: JSON.stringify(body) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["incidents", projectId] });
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

// Resolve every "recovery detected" incident in one click by confirming each
// incident's pending resolution proposal. There's no server-side bulk route —
// we fan out to the same confirm endpoint the single-incident banner uses, so
// each confirm still runs the full resolve + PR-close side effects and stays
// race-safe. A proposal a teammate already decided comes back 409; that's the
// one expected, benign outcome, so we count it as "already resolved" and keep
// going. Any other failure (auth, 5xx, network) is unexpected — we rethrow so
// the mutation lands in its error state instead of silently reporting success.
// Returns how many confirms went through vs. were already resolved so the
// caller can surface a partial result.
export function useResolveAllRecoveryDetected(projectId: string) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (targets: { incidentId: string; proposalId: string }[]) => {
      // allSettled (not Promise.all) so every confirm finishes before we react
      // — Promise.all would reject on the first failure while the remaining
      // requests keep running in the background, letting a retry overlap the
      // still-in-flight batch. Wait for the whole batch to quiesce, then rethrow
      // the first unexpected failure so the mutation lands in its error state.
      const results = await Promise.allSettled(
        targets.map(async (t) => {
          try {
            await fetcher<{ ok: true }>(
              `/api/projects/${projectId}/incidents/${t.incidentId}/resolution-proposals/${t.proposalId}/confirm`,
              { method: "POST" },
            );
            return "resolved" as const;
          } catch (err) {
            if (err instanceof Error && err.message.startsWith("409:")) {
              return "already" as const;
            }
            throw err;
          }
        }),
      );
      const failed = results.find((r) => r.status === "rejected");
      if (failed) throw failed.reason;
      const resolved = results.filter(
        (r) => r.status === "fulfilled" && r.value === "resolved",
      ).length;
      return { resolved, alreadyResolved: results.length - resolved };
    },
    onSuccess: (_data, targets) => {
      qc.invalidateQueries({ queryKey: ["incidents", projectId] });
      for (const t of targets) {
        qc.invalidateQueries({ queryKey: ["incident", projectId, t.incidentId] });
        qc.invalidateQueries({ queryKey: ["incident-investigation", projectId, t.incidentId] });
      }
    },
  });
}

export function useUpdateIncident(projectId: string) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      incidentId: string;
      status: "open" | "resolved";
      resolution?: "problem_resolved" | "not_an_issue";
    }) =>
      fetcher<Incident>(`/api/projects/${projectId}/incidents/${vars.incidentId}`, {
        method: "PATCH",
        body: JSON.stringify({ status: vars.status, resolution: vars.resolution }),
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

export type SavedViewVisibility = "personal" | "workspace";

export type SavedView = {
  id: string;
  name: string;
  visibility: SavedViewVisibility;
  state: SavedExploreViewState;
  ownedByMe: boolean;
  createdAt: string;
  updatedAt: string;
};

const savedViewsQueryKey = (projectId: string | undefined) => ["saved-views", projectId];

export function useSavedViews(projectId: string | undefined) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: savedViewsQueryKey(projectId),
    queryFn: () => fetcher<SavedView[]>(`/api/projects/${projectId}/saved-views`),
    enabled: !!projectId,
  });
}

export function useCreateSavedView(projectId: string | undefined) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      name: string;
      visibility: SavedViewVisibility;
      state: SavedExploreViewState;
    }) =>
      fetcher<SavedView>(`/api/projects/${requireProjectId(projectId)}/saved-views`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: savedViewsQueryKey(projectId) }),
  });
}

export function useUpdateSavedView(projectId: string | undefined) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string; state?: SavedExploreViewState }) =>
      fetcher<SavedView>(`/api/projects/${requireProjectId(projectId)}/saved-views/${id}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: savedViewsQueryKey(projectId) }),
  });
}

export function useDeleteSavedView(projectId: string | undefined) {
  const fetcher = useFetcher();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      fetcher<{ ok: true }>(`/api/projects/${requireProjectId(projectId)}/saved-views/${id}`, {
        method: "DELETE",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: savedViewsQueryKey(projectId) }),
  });
}

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
export type ExploreAttributeSource = "logs" | "traces" | "metrics";

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

export function useExploreAttributeKeys(
  projectId: string | undefined,
  range: ExploreRange,
  source?: ExploreAttributeSource,
) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: ["explore", "attribute-keys", projectId, range.since, range.until, source ?? ""],
    queryFn: () =>
      fetcher<AttributeKey[]>(
        `/api/projects/${projectId}/explore/attribute-keys?since=${encodeURIComponent(
          range.since,
        )}&until=${encodeURIComponent(range.until)}${source ? `&source=${source}` : ""}`,
      ),
    enabled: !!projectId,
  });
}

export function useExploreAttributeValues(
  projectId: string | undefined,
  key: string | undefined,
  range: ExploreRange,
  source?: ExploreAttributeSource,
) {
  const fetcher = useFetcher();
  return useQuery({
    queryKey: [
      "explore",
      "attribute-values",
      projectId,
      key,
      range.since,
      range.until,
      source ?? "",
    ],
    queryFn: () => {
      if (!projectId || !key) return Promise.resolve([]);
      return fetcher<AttributeValue[]>(
        `/api/projects/${projectId}/explore/attribute-values?key=${encodeURIComponent(
          key,
        )}&since=${encodeURIComponent(range.since)}&until=${encodeURIComponent(range.until)}${
          source ? `&source=${source}` : ""
        }`,
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
