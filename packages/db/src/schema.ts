import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { DEFAULT_AGENT_RUN_PROVIDER } from "./agent-runtime.js";

const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});

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
  spanName?: string | null;
  severityNumber?: number | null;
  spanAttrs?: Record<string, string> | null;
  logAttrs?: Record<string, string> | null;
  resourceAttrs?: Record<string, string> | null;
};

export type GithubRepoAccess = {
  disabledRepoIds?: number[];
};

export type PrObservabilitySignal = "logs" | "traces" | "metrics" | "cross-signal";
export type PrObservabilityReviewStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "superseded";
export type PrObservabilitySuggestion = {
  signal: PrObservabilitySignal;
  severity: "blocking" | "warning";
  path: string;
  line: number;
  title: string;
  body: string;
  confidence: number;
  githubCommentId: number;
  githubCommentUrl: string;
};

export type AgentRunFailureReason =
  | "agent_no_findings"
  | "patch_validation_failed"
  | "pr_open_failed"
  | "terminated_without_result"
  | "runtime_budget_exhausted"
  | "wall_clock_timeout"
  | "unknown_custom_tool"
  | "human_resume_budget_exhausted"
  | "start_failed"
  | "sync_failed"
  | "resume_failed"
  | "missing_session"
  | "missing_session_for_resume"
  | "github_repo_discovery_failed"
  | "github_repo_token_failed"
  | "unsupported_provider"
  // The run's incident or project no longer exists, so its context can never
  // load and it can never make progress — reaped from the tick rather than
  // left to rotate through the active set forever.
  | "context_unavailable";

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
  // Per-repository mobile regression decision for batched PR outcomes.
  // `AgentRunResult.mobileRegressionTest` remains the legacy singular mirror.
  mobileRegressionTest?: AgentRunMobileRegressionTest | null;
  openStatus: "pending" | "opened";
  url?: string | null;
};

// Manual recovery contract for a GitHub PR mutation whose compensating close
// could not be verified. Persisted with an awaiting_human result so a resumed
// turn and every UI/API reader retain the exact repository operation a person
// must reconcile; this is JSON-only metadata and requires no schema migration.
export type AgentRunPullRequestManualReconciliation = {
  actionRequired: "close_pull_request" | "sync_canonical_state";
  repoFullName: string;
  branchName: string;
  prUrl: string;
  prNumber: number;
  reconciliationReason: "incident_not_open" | "reconciliation_failed";
  reconciliationError: string | null;
  closeError: string | null;
  canonicalState: AgentPrState | null;
};

export type AgentRunLinearTicket = {
  id: string;
  url?: string | null;
  createdByAgent: boolean;
};

export type AgentRunMobileRegressionTest =
  | {
      status: "created";
      testId: string;
      url?: string | null;
      reason?: string | null;
    }
  | {
      status: "skipped" | "not_applicable";
      reason: string;
      testId?: string | null;
      url?: string | null;
    };

export type IncidentSeverity = "SEV-1" | "SEV-2" | "SEV-3";

// Why auto-investigation was skipped for this incident, when the reason is worth
// surfacing to the user. Currently only `no_credits`: the org is over its plan's
// monthly investigation limit and billing enforcement is on. Extend this union
// (don't repurpose it) if other user-actionable skip reasons need surfacing.
export type IncidentAutoInvestigateBlockedReason = "no_credits";
// "autoresolved_noise" is legacy: noise verdicts now silence the linked issues
// and resolve the incident plainly. Rows written by pre-cutover workers are
// migrated to "resolved"; readers must still treat any straggler as closed.
export type IncidentStatus = "open" | "resolved" | "autoresolved_noise" | "merged";

// Issue lifecycle. `open` issues drive incidents; `silenced` and
// `under_observation` suppress incident creation while occurrences keep
// accumulating on the same row; `resolved` issues re-open and start a NEW
// incident (chained via incidents.previous_incident_id) on recurrence.
export type IssueStatus = "open" | "silenced" | "under_observation" | "resolved";

// Escalation trigger for `under_observation` issues. `rate` fires when the
// issue's events over the trailing 5-minute window average >= perMinute;
// `count` fires when event_count has grown by >= count since observation began
// (baseline in issues.observation_baseline_event_count).
export type IssueEscalationTrigger =
  | { kind: "rate"; perMinute: number }
  | { kind: "count"; count: number };

// Free-form text explaining why the issue is noise. Previously a closed enum
// (cosmetic_log_only, lifecycle_signal, self_telemetry, expected_third_party,
// confusing_log_no_impact); those values still occur in stored rows and remain
// valid strings — render the text as-is.
export type IncidentNoiseReason = string;

// What to do with the incident's issues once a noise verdict lands. Silence
// suppresses future occurrences outright; observe suppresses until the
// escalation trigger trips (see IssueEscalationTrigger). Absent action means
// silence — the safe default for "intended behaviour / no impact".
export type IncidentNoiseAction =
  | { kind: "silence" }
  | { kind: "observe"; trigger: IssueEscalationTrigger };

export type IncidentNoiseClassification = {
  reason: IncidentNoiseReason;
  evidence: string;
  action?: IncidentNoiseAction | null;
};

// Free-form text explaining why the incident/issue is considered resolved.
// Previously a closed enum (fixed_in_current_code, transient_condition_cleared,
// upstream_recovered); stored rows may still carry those values.
export type IncidentResolutionReason = string;

export type IncidentResolutionClassification = {
  reason: IncidentResolutionReason;
  evidence: string;
};

// Who or what flipped an incident to `status='resolved'`. Distinct from
// `noiseReason`, which lives in its own column for the `autoresolved_noise`
// status path.
export type IncidentResolvedByKind =
  | "agent_pr_merged" // our agent opened a PR, GitHub said it merged
  | "linear_ticket_completed" // the run's Linear handoff entered a completed state
  | "agent_classification" // agent run completed with resolutionClassification.reason set
  | "slack_manual" // human clicked the Resolve button in Slack
  | "autorecovery_confirmed" // autorecovery agent proposed, human clicked Confirm
  | "dashboard_manual"; // human used the dashboard's mark-resolved control

// Free-form code emitted by the autorecovery agent to describe *why* an incident
// looks resolved without a code change on our side. Kept as text rather than
// a typed enum so the agent can introduce new categories without a migration;
// the dashboard renders the underlying text.
export type IncidentResolutionProposalReasonCode = string;

export type IncidentResolutionProposalConfidence = "low" | "medium" | "high";
export type IncidentResolutionProposalDecision = "confirmed" | "dismissed" | "expired";

export type AgentRunConfidence = {
  text: string;
  // 0-10 scale. 10 = backed by verbatim code/log/trace/ticket evidence; 0 = pure speculation.
  confidence: number;
};

// "issue_joined" is a machine-originated follow-up: a new error signature joined
// an already-investigated incident. Instead of starting a fresh investigation
// (which produced duplicate PRs for the same root cause), it steers the existing
// investigation — same continuation path as the human channels below.
// "pr_merged" / "pr_closed" are GitHub lifecycle events on an agent PR: they
// resume the investigation so the agent decides whether the incident is done
// (resolve_incident) or more work remains.
export type AgentRunTrigger =
  | "incident"
  | "manual"
  | "linear"
  | "pr_comment"
  | "pr_merged"
  | "pr_closed"
  | "feedback"
  | "slack_reply"
  | "linear_reply"
  | "web_chat"
  | "issue_joined";

// Triggers that start an *initial* investigation (vs. a follow-up revived by a
// human interaction after a prior run): "incident" (auto, from telemetry),
// "manual" (a user-started investigation from a typed prompt), and "linear"
// (a delegated Linear issue).
export const INITIAL_AGENT_RUN_TRIGGERS: readonly AgentRunTrigger[] = [
  "incident",
  "manual",
  "linear",
];

export function isFollowUpTrigger(trigger: AgentRunTrigger): boolean {
  return !INITIAL_AGENT_RUN_TRIGGERS.includes(trigger);
}

// Follow-up runs are revived by an inbound interaction on one of these channels.
export type AgentRunFollowUpTrigger = Exclude<AgentRunTrigger, "incident" | "manual" | "linear">;

export type AgentRunFollowUpInteraction = {
  channel: AgentRunFollowUpTrigger;
  // Stable identity for PR lifecycle interactions. This lets a worker that
  // discovers a reclaimed provider session apply the same incident-wide
  // fallback as the webhook without inferring identity from display text.
  agentPrId?: string;
  author: string | null;
  text: string;
  // PR comments: the comment URL and, for review comments, the file/line.
  url?: string | null;
  path?: string | null;
  line?: number | null;
  occurredAt: string;
};

// Durable identity for every still-open pull request carried into a cold-start
// follow-up. A batched delivery can outlive the provider session, so the
// successor must not have to infer the remaining work from the legacy single
// `result.pr` field.
export type AgentRunFollowUpPullRequest = {
  agentPrId: string;
  repoFullName: string;
  prNumber: number;
  url: string;
  branchName: string;
  baseBranch: string;
  state: AgentPrState;
};

export type AgentRunTriggerDetail = {
  interactions: AgentRunFollowUpInteraction[];
  pullRequests?: AgentRunFollowUpPullRequest[];
};

// Lifecycle of a provider Q&A chat (one row per Slack thread / DM channel or
// Linear AgentSession).
// queued: an unanswered inbound message is waiting for the worker (covers
// both "no session yet" and "idle session to resume"). running: the session
// is working a turn. idle: answered, waiting for the next human message.
// failed: the last turn failed; a new inbound message re-queues it.
export type AgentChatState = "queued" | "running" | "idle" | "failed";

// One issue-level verdict recorded by the agent. New runs supply the complete
// set through terminal resolve_incident and commit it atomically with the
// Incident; persisted legacy runs may contain earlier action-by-action data.
export type AgentRunIssueClassification = {
  issueId: string;
  action: "silence" | "observe" | "resolve";
  reason: string;
  evidence: string;
  trigger?: IssueEscalationTrigger | null;
};

// The agent's terminal resolve_incident verdict.
export type AgentRunIncidentResolution = {
  reason: string;
  evidence: string;
};

export type AgentRunExternalCause = {
  cause: string;
  source: string;
  evidence: string;
  recommendedNextStep: string;
};

export type AgentRunResult = {
  state: "complete" | "awaiting_human" | "awaiting_events" | "failed";
  summary: string;
  // Explicit terminal signal for runs that finish their investigation while
  // deliberately leaving the incident open for an external ticket workflow.
  completionKind?: "investigation_complete" | null;
  // Why an awaiting_events run is parked when it is not waiting on a PR.
  waitReason?: "external_cause" | null;
  externalCause?: AgentRunExternalCause | null;
  question?: string | null;
  manualReconciliation?: AgentRunPullRequestManualReconciliation | null;
  failureReason?: AgentRunFailureReason | null;
  // Legacy single-PR record (pre multi-PR contract). New runs record opened
  // PRs as agent_pull_requests rows (the source of truth) and mirror them in
  // `prs`; `pr` is kept pointing at the most recent one for old readers.
  pr?: AgentRunPr | null;
  prs?: AgentRunPr[] | null;
  issueClassifications?: AgentRunIssueClassification[] | null;
  incidentResolution?: AgentRunIncidentResolution | null;
  // Stable receipt for the exact resolve_incident tool use whose atomic
  // lifecycle transaction this result describes. Run IDs are reused across
  // resumed turns, so completion must prove against this per-call key.
  incidentResolutionEventDedupeKey?: string | null;
  linearTicket?: AgentRunLinearTicket | null;
  rootCauseConfidence?: "high" | "medium" | "low" | null;
  // Concise human-readable replacement for incident.title — applied by the worker if present.
  proposedTitle?: string | null;
  rootCause?: AgentRunConfidence | null;
  estimatedImpact?: AgentRunConfidence | null;
  severity?: IncidentSeverity | null;
  // Self-authored handover note for future follow-up runs on this incident:
  // files/areas examined, hypotheses ruled out and why, repo gotchas. Written
  // at completion when the agent still has full context.
  handoffNotes?: string | null;
  mobileRegressionTest?: AgentRunMobileRegressionTest | null;
  noiseClassification?: IncidentNoiseClassification | null;
  resolutionClassification?: IncidentResolutionClassification | null;
};

export const orgs = pgTable("orgs", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  clerkOrgId: text("clerk_org_id").unique(),
  // Better Auth organization plugin fields.
  logo: text("logo"),
  metadata: text("metadata"),
  githubSetupSkippedAt: timestamp("github_setup_skipped_at", {
    withTimezone: true,
  }),
  signupSource: text("signup_source"),
  // Exact-match hostnames allowed as `return_url` for management-API flows
  // that hand control back to a customer-controlled URL (e.g. GitHub install
  // bounce-back). Defaults to empty: the management key alone is NOT a
  // sufficient gate against open-redirect phishing. A human dashboard admin
  // must explicitly register the host first.
  allowedReturnUrlHosts: text("allowed_return_url_hosts")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  // Better Auth core user fields.
  name: text("name").notNull().default(""),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  // Better Auth admin plugin fields. `role` is a comma-separated list of role
  // names ("admin", "user", or a custom set). A user with "admin" in this list
  // is considered staff and gets access to /admin/*.
  role: text("role"),
  banned: boolean("banned").notNull().default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires", { withTimezone: true }),
  // Legacy Clerk identity, kept during cutover for export/lookup. Drop in Phase F.
  clerkId: text("clerk_id").unique(),
  // Last-used project, persisted across sessions. Seeded to the favorite at
  // session start (auth.ts) and overwritten whenever the user switches project.
  activeProjectId: uuid("active_project_id").references(() => projects.id, {
    onDelete: "set null",
  }),
  // Last-used org, persisted across sessions. The active org otherwise lives on
  // the session row (Better Auth); this mirrors it so a fresh login can reopen
  // the org the user last worked in instead of resetting to their first one.
  activeOrgId: uuid("active_org_id").references(() => orgs.id, {
    onDelete: "set null",
  }),
  // Pinned "favorite" org + project. When set, a fresh session opens these
  // regardless of what was last used. favoriteProjectId always belongs to
  // favoriteOrgId (enforced when set via PUT /api/me/favorite).
  favoriteOrgId: uuid("favorite_org_id").references(() => orgs.id, {
    onDelete: "set null",
  }),
  favoriteProjectId: uuid("favorite_project_id").references(() => projects.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const orgMembers = pgTable(
  "org_members",
  {
    // Better Auth's organization plugin requires an `id` PK on member rows.
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uniq: uniqueIndex("org_members_org_user_idx").on(t.orgId, t.userId),
  }),
);

// --- Better Auth tables ---
// These are owned by Better Auth (https://better-auth.com) and mapped via the
// drizzle adapter's `schema` option in apps/api/src/auth.ts. Column names
// follow Better Auth's expected shape so the adapter wires up cleanly.

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    // Set by the organization plugin to remember which org the user is acting in.
    activeOrganizationId: uuid("active_organization_id").references(() => orgs.id, {
      onDelete: "set null",
    }),
    // Better Auth admin plugin: set when an admin is impersonating this user;
    // holds the admin's user id so the session can be unwound on stop.
    impersonatedBy: text("impersonated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index("sessions_user_idx").on(t.userId),
    expiresIdx: index("sessions_expires_idx").on(t.expiresAt),
  }),
);

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // For email/password: accountId = userId, providerId = "credential", password is set.
    // For OAuth: accountId = provider's stable user ID, providerId = "google"/"github"/etc.
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    providerAccountUniq: uniqueIndex("accounts_provider_account_idx").on(t.providerId, t.accountId),
    userIdx: index("accounts_user_idx").on(t.userId),
  }),
);

export const verifications = pgTable(
  "verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    identifierIdx: index("verifications_identifier_idx").on(t.identifier),
  }),
);

export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    status: text("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    inviterId: uuid("inviter_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgIdx: index("invitations_org_idx").on(t.orgId),
    emailIdx: index("invitations_email_idx").on(t.email),
  }),
);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    projectContext: text("project_context").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    // First time this project ever had telemetry accepted. Claimed atomically by
    // the proxy (UPDATE ... WHERE first_telemetry_at IS NULL) so the activation
    // event fires exactly once per project, independent of how many ingest keys
    // it has or how many requests race in. Null until the project activates.
    firstTelemetryAt: timestamp("first_telemetry_at", { withTimezone: true }),
  },
  (t) => ({
    uniq: uniqueIndex("projects_org_slug_idx").on(t.orgId, t.slug),
    // Lets child tables carry (project_id, org_id) composite FKs that
    // guarantee the project belongs to the same org as the row.
    idOrgUniq: unique("projects_id_org_uniq").on(t.id, t.orgId),
  }),
);

export const projectMcpServers = pgTable(
  "project_mcp_servers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    url: text("url").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    authType: text("auth_type")
      .$type<"none" | "bearer" | "api_key" | "oauth">()
      .notNull()
      .default("none"),
    authCiphertext: bytea("auth_ciphertext"),
    authNonce: bytea("auth_nonce"),
    authKeyVersion: integer("auth_key_version"),
    trustedAt: timestamp("trusted_at", { withTimezone: true }).notNull(),
    trustedByUserId: uuid("trusted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    projectNameUniq: uniqueIndex("project_mcp_servers_project_name_idx").on(t.projectId, t.name),
    projectUrlUniq: uniqueIndex("project_mcp_servers_project_url_idx").on(t.projectId, t.url),
    projectEnabledIdx: index("project_mcp_servers_project_enabled_idx").on(t.projectId, t.enabled),
    authFieldsCheck: check(
      "project_mcp_servers_auth_fields_check",
      sql`(
        auth_type = 'none'
        AND auth_ciphertext IS NULL
        AND auth_nonce IS NULL
        AND auth_key_version IS NULL
      ) OR (
        auth_type IN ('bearer', 'api_key', 'oauth')
        AND auth_ciphertext IS NOT NULL
        AND auth_nonce IS NOT NULL
        AND auth_key_version IS NOT NULL
      )`,
    ),
  }),
);

export const projectMcpOauthAttempts = pgTable(
  "project_mcp_oauth_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => projectMcpServers.id, { onDelete: "cascade" }),
    stateHash: text("state_hash").notNull().unique(),
    payloadCiphertext: bytea("payload_ciphertext").notNull(),
    payloadNonce: bytea("payload_nonce").notNull(),
    payloadKeyVersion: integer("payload_key_version").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    serverIdx: index("project_mcp_oauth_attempts_server_idx").on(t.serverId),
    expiryIdx: index("project_mcp_oauth_attempts_expiry_idx").on(t.expiresAt),
  }),
);

export const apiKeys = pgTable("api_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  keyPrefix: text("key_prefix").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// Org-scoped management API keys. Used by customer backends
// to programmatically provision projects, mint ingest keys, etc. Not for
// telemetry ingest — that's still `api_keys` above, project-scoped.
export const orgApiKeys = pgTable(
  "org_api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgIdx: index("org_api_keys_org_idx").on(t.orgId),
  }),
);

export const signupIntents = pgTable("signup_intents", {
  id: text("id").primaryKey(),
  keyPrefix: text("key_prefix").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  returnTo: text("return_to"),
  claimedProjectId: uuid("claimed_project_id").references(() => projects.id, {
    onDelete: "set null",
  }),
  claimedByUserId: uuid("claimed_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const issues = pgTable(
  "issues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    fingerprint: text("fingerprint").notNull(),
    kind: text("kind").notNull().default("span"),
    service: text("service"),
    exceptionType: text("exception_type").notNull(),
    title: text("title").notNull(),
    message: text("message"),
    topFrame: text("top_frame"),
    normalizedFrames: jsonb("normalized_frames")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    lastSample: jsonb("last_sample").$type<IssueSample>(),
    firstSeen: timestamp("first_seen", { withTimezone: true }).notNull(),
    lastSeen: timestamp("last_seen", { withTimezone: true }).notNull(),
    // Lifecycle state; see IssueStatus. Ingest suppresses incident work for
    // silenced/under_observation issues while still bumping counters, so the
    // row keeps recording occurrences for reporting and trigger evaluation.
    status: text("status").$type<IssueStatus>().notNull().default("open"),
    // Timestamp of the most recent silence; kept alongside `status` so the UI
    // can say "silenced 3 weeks ago" and unsilence audits have a marker.
    silencedAt: timestamp("silenced_at", { withTimezone: true }),
    // Set while status='under_observation'. The trigger is required by the
    // domain (an observation without a trigger can never escalate); the
    // baseline anchors `count` triggers to growth since observation began.
    escalationTrigger: jsonb("escalation_trigger").$type<IssueEscalationTrigger>(),
    observationStartedAt: timestamp("observation_started_at", { withTimezone: true }),
    observationBaselineEventCount: bigint("observation_baseline_event_count", {
      mode: "number",
    }),
    // Rate-trigger bookkeeping: the sweep fires a `rate` trigger off the
    // event_count delta since the previous evaluation, so it needs the last
    // counter + timestamp it saw. Null until the sweep's first pass.
    observationLastEvaluatedAt: timestamp("observation_last_evaluated_at", {
      withTimezone: true,
    }),
    observationLastEventCount: bigint("observation_last_event_count", { mode: "number" }),
    lastAlertedAt: timestamp("last_alerted_at", { withTimezone: true }),
    slackMessageTs: text("slack_message_ts"),
    eventCount: bigint("event_count", { mode: "number" }).notNull().default(0),
    groupingState: text("grouping_state").notNull().default("grouped"),
    groupingSource: text("grouping_source"),
    groupingReason: text("grouping_reason"),
    groupingAttemptedAt: timestamp("grouping_attempted_at", {
      withTimezone: true,
    }),
    groupingAttemptCount: integer("grouping_attempt_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // Full uniqueness (no silenced carve-out): an occurrence of a silenced or
    // observed fingerprint must land on the existing row and be suppressed
    // there, never spawn a fresh issue. Duplicates that predate this rule are
    // collapsed by the 0081 data migration.
    uniq: uniqueIndex("issues_project_fingerprint_idx").on(t.projectId, t.fingerprint),
    groupingStateIdx: index("issues_grouping_state_idx")
      .on(t.projectId, t.groupingState)
      .where(sql`grouping_state IN ('pending', 'failed')`),
    // Observation sweep scan: only under_observation rows are ever evaluated.
    observationIdx: index("issues_observation_idx")
      .on(t.projectId, t.observationStartedAt)
      .where(sql`status = 'under_observation'`),
    statusIdx: index("issues_project_status_idx").on(t.projectId, t.status),
  }),
);

export const incidents = pgTable(
  "incidents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    service: text("service"),
    // Deployment environment (e.g. "production", "staging") of the error that
    // opened the incident, denormalized from the triggering issue's telemetry
    // resource attributes (same pattern as `service`). Nullable: many setups
    // don't tag a `deployment.environment` attribute, and pre-this-column rows
    // never captured it.
    environment: text("environment"),
    title: text("title").notNull(),
    // Human-friendly per-project name (e.g. "squishy-narwhal"). Stable for the life of the incident.
    codename: text("codename").notNull().default(""),
    severity: text("severity").$type<IncidentSeverity>(),
    // status: 'open' | 'resolved' | 'autoresolved_noise' | 'merged'. Noise carves out
    // reopen-on-recurrence; recurring events bump issue_count/last_seen but keep the noise
    // status until weekly review. Merged incidents have their incident_issues repointed to
    // the survivor at mergedIntoId; lookups should follow the chain to find the live row.
    status: text("status").$type<IncidentStatus>().notNull().default("open"),
    noiseReason: text("noise_reason").$type<IncidentNoiseReason>(),
    noiseResolvedAt: timestamp("noise_resolved_at", { withTimezone: true }),
    mergedIntoId: uuid("merged_into_id").references((): AnyPgColumn => incidents.id, {
      onDelete: "set null",
    }),
    mergedAt: timestamp("merged_at", { withTimezone: true }),
    // Recurrence chain: when a resolved issue recurs (or an escalation trigger
    // fires), we open a NEW incident rather than reopening the old one, and
    // point it at its predecessor here. Agent runs on the new incident get the
    // predecessors' findings injected as context.
    previousIncidentId: uuid("previous_incident_id").references((): AnyPgColumn => incidents.id, {
      onDelete: "set null",
    }),
    firstSeen: timestamp("first_seen", { withTimezone: true }).notNull(),
    lastSeen: timestamp("last_seen", { withTimezone: true }).notNull(),
    issueCount: integer("issue_count").notNull().default(1),
    slackChannelId: text("slack_channel_id"),
    slackThreadTs: text("slack_thread_ts"),
    // Pin the thread root to the specific Slack installation (workspace + bot
    // token) that posted it. Without this we'd have to look up the org's
    // installation by `org_id`, which is ambiguous when an org has installed
    // Superlog into multiple Slack workspaces — picking the wrong workspace's
    // bot to talk to a thread it doesn't have access to gets `channel_not_found`
    // back, which our anchor-staleness heuristic would mistakenly act on.
    // Nullable so existing rows (pre-this-column) still load; the worker falls
    // back to looking up the project's current route in that case.
    slackInstallationId: uuid("slack_installation_id").references(
      (): AnyPgColumn => slackInstallations.id,
      { onDelete: "set null" },
    ),
    lastSlackPostedAt: timestamp("last_slack_posted_at", {
      withTimezone: true,
    }),
    // Suppress auto-investigation until this time. Set when an agent run
    // resolves an incident as `fixed_in_current_code`, since prod recurrence
    // before the deploy promotes is expected and shouldn't re-trigger the agent.
    // Manual restarts ignore this field.
    autoInvestigateSuppressedUntil: timestamp("auto_investigate_suppressed_until", {
      withTimezone: true,
    }),
    // Why the most recent issue transition did NOT queue an auto-investigation,
    // when it was skipped for a reason worth showing the user. Currently only
    // 'no_credits' — the org is over its plan's monthly investigation limit and
    // billing enforcement is on (see apps/worker billing/investigation-gate).
    // NULL when an investigation was queued or was never blocked; cleared back
    // to NULL once a run is successfully queued.
    autoInvestigateBlockedReason: text(
      "auto_investigate_blocked_reason",
    ).$type<IncidentAutoInvestigateBlockedReason>(),
    // Last time the autorecovery sweep evaluated this incident (regardless of
    // outcome — proposed, still-happening, below-confidence, or skipped). The
    // sweep orders candidates by this column (NULLS FIRST) so it drains the
    // whole open-incident backlog fairly instead of re-chewing the most
    // recently active 20 every tick. NULL = never evaluated.
    autorecoveryLastEvaluatedAt: timestamp("autorecovery_last_evaluated_at", {
      withTimezone: true,
    }),
    // Agent findings. Written by the worker when an agent run finishes
    // successfully (overwrite-on-success — a later run can correct an earlier
    // wrong guess; the timeline records each run as a separate event).
    agentSummary: text("agent_summary"),
    rootCauseText: text("root_cause_text"),
    rootCauseConfidence: integer("root_cause_confidence"),
    estimatedImpactText: text("estimated_impact_text"),
    estimatedImpactConfidence: integer("estimated_impact_confidence"),
    suggestedSeverity: text("suggested_severity").$type<IncidentSeverity>(),
    noiseClassification: jsonb("noise_classification").$type<IncidentNoiseClassification>(),
    resolutionClassification: jsonb(
      "resolution_classification",
    ).$type<IncidentResolutionClassification>(),
    findingsAgentRunId: uuid("findings_agent_run_id").references((): AnyPgColumn => agentRuns.id, {
      onDelete: "set null",
    }),
    // Structured resolution metadata. Populated alongside `status='resolved'`
    // by every resolve path (PR merge, agent classification, Slack manual,
    // sweep proposal confirmed). Cleared back to NULL when recurrence
    // re-opens the incident. `resolvedByKind` is the discriminator; one of
    // `resolvedByUserId` / `resolvedBySlackUserId` may also be set depending
    // on the path. `resolvedReasonCode` is a short code (e.g.
    // `fixed_in_current_code`, `agent_pr_merged`, `external_dependency_recovered`)
    // for filtering; `resolvedReasonText` is the human-readable evidence.
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedByKind: text("resolved_by_kind").$type<IncidentResolvedByKind>(),
    resolvedByUserId: uuid("resolved_by_user_id").references((): AnyPgColumn => users.id, {
      onDelete: "set null",
    }),
    resolvedBySlackUserId: text("resolved_by_slack_user_id"),
    resolvedReasonCode: text("resolved_reason_code"),
    resolvedReasonText: text("resolved_reason_text"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    projectStatusSeenIdx: index("incidents_project_status_seen_idx").on(
      t.projectId,
      t.status,
      t.lastSeen,
    ),
    // Supports the autorecovery sweep's "least-recently-evaluated open
    // incident first" scan (selectCandidates orders by this column).
    autorecoveryEvalIdx: index("incidents_autorecovery_eval_idx").on(
      t.status,
      t.autorecoveryLastEvaluatedAt,
    ),
    slackThreadIdx: uniqueIndex("incidents_slack_thread_idx").on(t.slackChannelId, t.slackThreadTs),
    projectCodenameIdx: uniqueIndex("incidents_project_codename_idx")
      .on(t.projectId, t.codename)
      .where(sql`codename <> ''`),
  }),
);

export const incidentIssues = pgTable(
  "incident_issues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    incidentId: uuid("incident_id")
      .notNull()
      .references(() => incidents.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // An issue accumulates one link per incident it has driven over its life
    // (recurrence opens a new incident and appends a new link). The latest
    // link by created_at is the issue's *current* incident.
    incidentIssuePairUniq: uniqueIndex("incident_issues_pair_idx").on(t.incidentId, t.issueId),
    incidentLookupIdx: index("incident_issues_incident_idx").on(t.incidentId),
    issueLookupIdx: index("incident_issues_issue_lookup_idx").on(t.issueId, t.createdAt),
  }),
);

// One row per "should this incident be resolved?" proposal emitted by the
// resolution-sweep agent. Append-only audit log + state machine for the
// Slack Confirm/Dismiss buttons.
//
// `sourceKind` is currently only `'sweep'` but reserves room for future
// proposers (e.g. another human in Slack proposing resolution that needs a
// teammate to confirm). The `slackMessageTs` is how the interactivity
// handler finds the proposal row when a Confirm/Dismiss button is clicked.
//
// `decision` stays NULL until the user clicks. `'expired'` is reserved for a
// future cleanup pass that times out stale proposals.
export const incidentResolutionProposals = pgTable(
  "incident_resolution_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    incidentId: uuid("incident_id")
      .notNull()
      .references(() => incidents.id, { onDelete: "cascade" }),
    sourceKind: text("source_kind").notNull().default("sweep"),
    proposedReasonCode: text("proposed_reason_code").notNull(),
    proposedReasonText: text("proposed_reason_text").notNull(),
    confidence: text("confidence").$type<IncidentResolutionProposalConfidence>().notNull(),
    // Structured evidence the sweep agent referenced (sample log queries,
    // metric series, time windows). Free-form JSON so we can iterate on
    // what the agent stuffs in without migrating.
    evidence: jsonb("evidence").$type<Record<string, unknown>>(),
    slackInstallationId: uuid("slack_installation_id").references(
      (): AnyPgColumn => slackInstallations.id,
      { onDelete: "set null" },
    ),
    slackChannelId: text("slack_channel_id"),
    slackMessageTs: text("slack_message_ts"),
    proposedAt: timestamp("proposed_at", { withTimezone: true }).defaultNow().notNull(),
    decision: text("decision").$type<IncidentResolutionProposalDecision>(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedByUserId: uuid("decided_by_user_id").references((): AnyPgColumn => users.id, {
      onDelete: "set null",
    }),
    decidedBySlackUserId: text("decided_by_slack_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    incidentOpenProposalIdx: index("incident_resolution_proposals_incident_idx").on(
      t.incidentId,
      t.proposedAt,
    ),
    // Looking up "what proposal does this Slack button click refer to" — the
    // worker can also encode the proposal id in the action_id, but pinning a
    // unique index lets us recover from missing action_id metadata.
    slackMessageIdx: uniqueIndex("incident_resolution_proposals_slack_msg_idx")
      .on(t.slackChannelId, t.slackMessageTs)
      .where(sql`slack_channel_id IS NOT NULL AND slack_message_ts IS NOT NULL`),
  }),
);

export const projectAutomationSettings = pgTable(
  "project_automation_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    autoInvestigateIssuesEnabled: boolean("auto_investigate_issues_enabled")
      .notNull()
      .default(true),
    agentRunProvider: text("agent_run_provider").notNull().default(DEFAULT_AGENT_RUN_PROVIDER),
    maxRuntimeMinutes: integer("max_runtime_minutes").notNull().default(90),
    maxHumanResumeCount: integer("max_human_resume_count").notNull().default(3),
    customInstructions: text("custom_instructions").notNull().default(""),
    agentRunEnabled: boolean("agent_run_enabled").notNull().default(true),
    // Gate for follow-up runs auto-triggered by PR comments and Slack
    // replies after a prior run completed (feedback-triggered follow-ups
    // are always confirm-gated regardless).
    autoFollowUpEnabled: boolean("auto_follow_up_enabled").notNull().default(true),
    // Gate for Slack Q&A chats (@-mentions / DMs). Independent of
    // agentRunEnabled: a project can allow questions without allowing
    // auto-investigations, and vice versa.
    chatEnabled: boolean("chat_enabled").notNull().default(true),
    linearTicketPolicy: text("linear_ticket_policy")
      .$type<"never" | "on_ready_to_pr" | "always">()
      .notNull()
      .default("on_ready_to_pr"),
    linearTicketInstructions: jsonb("linear_ticket_instructions")
      .$type<LinearTicketInstruction[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    // Linear team to file agent tickets under. Null = first team in the
    // workspace (logged fallback).
    linearDefaultTeamId: text("linear_default_team_id"),
    prPolicy: text("pr_policy")
      .$type<"never" | "on_ready_to_pr" | "always">()
      .notNull()
      .default("on_ready_to_pr"),
    // Master switch for remediation actions that require a human approval
    // before the worker executes them. Availability is still determined by
    // the installed integrations' actual tool set.
    approvalPromptsEnabled: boolean("approval_prompts_enabled").notNull().default(true),
    // Resolving an incident is normally terminal without an extra handoff.
    // Projects that use Linear as their audit trail can opt into filing a
    // ticket for this terminal path as well.
    createLinearTicketOnResolve: boolean("create_linear_ticket_on_resolve")
      .notNull()
      .default(false),
    prBaseBranch: text("pr_base_branch"),
    // Slack digests follow the same project boundary as the installation and
    // incident channel. Null means this project has not adopted/configured a
    // digest yet, allowing the legacy org setting to be migrated once.
    digestEnabled: boolean("digest_enabled"),
    digestSlackInstallationId: uuid("digest_slack_installation_id").references(
      (): AnyPgColumn => slackInstallations.id,
      { onDelete: "set null" },
    ),
    digestSlackChannelId: text("digest_slack_channel_id"),
    digestSlackChannelName: text("digest_slack_channel_name"),
    digestLastRunAt: timestamp("digest_last_run_at", { withTimezone: true }),
    digestRunRequestedAt: timestamp("digest_run_requested_at", { withTimezone: true }),
    autoMergeFixPrs: text("auto_merge_fix_prs")
      .$type<"never" | "when_checks_pass" | "immediately">()
      .notNull()
      .default("never"),
    autoMergeMethod: text("auto_merge_method")
      .$type<"squash" | "merge" | "rebase">()
      .notNull()
      .default("squash"),
    // Pre-0050 text column. Kept in schema so drizzle doesn't try to drop it;
    // unused by code. Will be removed in a follow-up migration once
    // issue_filter_config has shipped.
    issueFilterLegacy: text("issue_filter").notNull().default(""),
    // Per-kind include/exclude attribute filters. See IssueFilterConfig.
    issueFilterConfig: jsonb("issue_filter_config")
      .$type<IssueFilterConfig>()
      .notNull()
      .default(
        sql`'{"includeLogs":[],"includeSpans":[],"excludeLogs":[],"excludeSpans":[]}'::jsonb`,
      ),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    projectUniq: uniqueIndex("project_automation_settings_project_idx").on(t.projectId),
  }),
);

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    incidentId: uuid("incident_id")
      .notNull()
      .references(() => incidents.id, { onDelete: "cascade" }),
    runtime: text("runtime").notNull().default(DEFAULT_AGENT_RUN_PROVIDER),
    state: text("state").notNull().default("queued"),
    // What started this run. "incident" is the normal investigation kicked
    // off when the incident opens; the rest are follow-up runs revived by a
    // human interaction after a prior run finished.
    trigger: text("trigger").$type<AgentRunTrigger>().notNull().default("incident"),
    // For follow-up runs: the interaction(s) that triggered it. Multiple
    // interactions accumulate while the run is still queued (e.g. a PR
    // review burst becomes one run, not one per comment).
    triggerDetail: jsonb("trigger_detail").$type<AgentRunTriggerDetail>(),
    // The user's free-text brief for a manual or delegated Linear
    // investigation, injected into the agent's initial prompt. Null for auto
    // telemetry incident runs.
    prompt: text("prompt"),
    providerSessionId: text("provider_session_id"),
    providerThreadId: text("provider_thread_id"),
    providerSessionStatus: text("provider_session_status"),
    selectedRepoFullName: text("selected_repo_full_name"),
    selectedRepoUrl: text("selected_repo_url"),
    selectedBaseBranch: text("selected_base_branch"),
    selectedRepoScore: integer("selected_repo_score"),
    cumulativeRuntimeMinutes: integer("cumulative_runtime_minutes").notNull().default(0),
    resumeCount: integer("resume_count").notNull().default(0),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lastSlackPostedAt: timestamp("last_slack_posted_at", {
      withTimezone: true,
    }),
    failureReason: text("failure_reason"),
    // Full agent output. Findings (root cause, severity suggestion, noise/
    // resolution classification, summary) are also flattened onto the incident
    // row by the worker on completion; this column preserves the raw structured
    // result for audit/debug.
    result: jsonb("result").$type<AgentRunResult>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    incidentLookupIdx: index("agent_runs_incident_idx").on(t.incidentId, t.createdAt),
    providerSessionUniq: uniqueIndex("agent_runs_provider_session_idx").on(t.providerSessionId),
  }),
);

export const incidentEvents = pgTable(
  "incident_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Nullable so incident-lifecycle events (manual resolves from the
    // dashboard or Slack, sweep proposal confirmations, anything that
    // isn't tied to a specific agent run) can still land in the
    // timeline. When set, the event also represents progress on that
    // run. When null, `incidentId` is the only join key.
    agentRunId: uuid("agent_run_id").references(() => agentRuns.id, {
      onDelete: "cascade",
    }),
    // Always set for incident-scoped events. Lets the timeline query find
    // every event for an incident with a single join, regardless of which
    // agent run (if any) produced it. Surviving without an
    // agent_run_id is the whole point of this column.
    incidentId: uuid("incident_id").references((): AnyPgColumn => incidents.id, {
      onDelete: "cascade",
    }),
    kind: text("kind").notNull(),
    summary: text("summary"),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    providerEventId: text("provider_event_id"),
    dedupeKey: text("dedupe_key"),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    slackPostedAt: timestamp("slack_posted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    agentRunLookupIdx: index("incident_events_agent_run_idx")
      .on(t.agentRunId, t.createdAt)
      .where(sql`agent_run_id IS NOT NULL`),
    incidentLookupIdx: index("incident_events_incident_idx")
      .on(t.incidentId, t.createdAt)
      .where(sql`incident_id IS NOT NULL`),
    // Dedupe scoped per (agent run, key) when the event is tied to a
    // run, per (incident, key) for lifecycle events. Postgres unique
    // indexes treat NULL as distinct, so two partial indexes are
    // cleaner than a single coalesced one.
    providerEventAgentRunUniq: uniqueIndex("incident_events_provider_event_idx")
      .on(t.agentRunId, t.providerEventId)
      .where(sql`agent_run_id IS NOT NULL`),
    providerEventIncidentUniq: uniqueIndex("incident_events_incident_provider_event_idx")
      .on(t.incidentId, t.providerEventId)
      .where(sql`agent_run_id IS NULL AND incident_id IS NOT NULL`),
    dedupeAgentRunUniq: uniqueIndex("incident_events_dedupe_idx")
      .on(t.agentRunId, t.dedupeKey)
      .where(sql`agent_run_id IS NOT NULL`),
    dedupeIncidentUniq: uniqueIndex("incident_events_incident_dedupe_idx")
      .on(t.incidentId, t.dedupeKey)
      .where(sql`agent_run_id IS NULL AND incident_id IS NOT NULL`),
    // Every event must link to at least one parent. Without this, a row
    // could land with both columns NULL and bypass every dedupe / lookup
    // index above — invisible orphan that the timeline UI also can't reach.
    parentageCheck: check(
      "incident_events_parentage_check",
      sql`agent_run_id IS NOT NULL OR incident_id IS NOT NULL`,
    ),
  }),
);

// A Q&A conversation with the agent, started by mentioning it in a connected
// provider — deliberately NOT an incident and NOT an
// agent_run: the investigation pipeline (PR delivery, noise verdicts, incident
// anchoring) is incident-shaped end to end, while a chat is just a durable
// provider session that answers questions about the project's code and
// telemetry. One row per conversation; the (channel, thread) anchor is how
// inbound Slack events find it; Linear conversations are anchored through
// linear_agent_sessions.
export const agentChats = pgTable(
  "agent_chats",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    provider: text("provider").$type<"slack" | "linear">().notNull().default("slack"),
    // Pinned at creation so replies keep working when the project's Slack
    // route changes later; nulled if the installation row is deleted (the
    // team-wide fallback lookup still works via slackTeamId).
    slackInstallationId: uuid("slack_installation_id").references(
      (): AnyPgColumn => slackInstallations.id,
      { onDelete: "set null" },
    ),
    slackTeamId: text("slack_team_id"),
    slackChannelId: text("slack_channel_id"),
    // Thread anchor. NULL for DM chats: a DM channel is one continuous
    // conversation with no thread anchoring, so the channel id alone is the
    // key and replies post to the channel root.
    slackThreadTs: text("slack_thread_ts"),
    createdBySlackUserId: text("created_by_slack_user_id"),
    createdByLinearUserId: text("created_by_linear_user_id"),
    // First question, truncated — display/debug label only.
    title: text("title"),
    runtime: text("runtime").notNull().default(DEFAULT_AGENT_RUN_PROVIDER),
    state: text("state").$type<AgentChatState>().notNull().default("queued"),
    providerSessionId: text("provider_session_id"),
    providerSessionStatus: text("provider_session_status"),
    failureReason: text("failure_reason"),
    // Total active seconds across ALL provider sessions of this chat
    // (sessionBaseActiveSeconds + the live session's active time, folded in
    // per sync). Chats have no per-project runtime setting; the worker
    // enforces a constant cap on this total so one thread can't dodge the
    // budget by having its session reclaimed and cold-started.
    cumulativeActiveSeconds: integer("cumulative_active_seconds").notNull().default(0),
    // Active seconds accumulated by PRIOR (reclaimed/terminated) sessions.
    // Set to cumulativeActiveSeconds whenever a fresh session replaces a
    // dead one, so the budget survives session churn.
    sessionBaseActiveSeconds: integer("session_base_active_seconds").notNull().default(0),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // Channel-thread lookup for inbound events, scoped by the Slack team so
    // two workspaces that happen to reuse a channel/thread id can never
    // collide into one chat (the anchor lookup filters on team id too).
    // Postgres unique indexes treat NULLs as distinct, so DM chats (NULL
    // thread) get their own per-channel partial index instead of relying on
    // the composite one.
    threadUniq: uniqueIndex("agent_chats_thread_idx")
      .on(t.slackTeamId, t.slackChannelId, t.slackThreadTs)
      .where(sql`provider = 'slack' AND slack_thread_ts IS NOT NULL`),
    dmChannelUniq: uniqueIndex("agent_chats_dm_channel_idx")
      .on(t.slackTeamId, t.slackChannelId)
      .where(sql`provider = 'slack' AND slack_thread_ts IS NULL`),
    providerSessionUniq: uniqueIndex("agent_chats_provider_session_idx").on(t.providerSessionId),
    // The worker tick scans active chats oldest-updated first.
    stateIdx: index("agent_chats_state_idx").on(t.state, t.updatedAt),
  }),
);

// Inbound queue for a chat: one row per human provider message, deduped on a
// provider event/message id so webhook retries can't double-feed the session.
// `processedAt` is stamped when the worker delivers the text into the
// provider session (resume/steer) — the same pending-marker pattern as
// source-specific incident interaction events.
export const agentChatMessages = pgTable(
  "agent_chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chatId: uuid("chat_id")
      .notNull()
      .references(() => agentChats.id, { onDelete: "cascade" }),
    authorSlackUserId: text("author_slack_user_id"),
    authorLinearUserId: text("author_linear_user_id"),
    text: text("text").notNull(),
    slackMessageTs: text("slack_message_ts"),
    providerMessageId: text("provider_message_id"),
    dedupeKey: text("dedupe_key").notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    dedupeUniq: uniqueIndex("agent_chat_messages_dedupe_idx").on(t.chatId, t.dedupeKey),
    pendingIdx: index("agent_chat_messages_pending_idx")
      .on(t.chatId, t.createdAt)
      .where(sql`processed_at IS NULL`),
  }),
);

export type AgentPrState = "open" | "closed" | "merged";

export const agentPullRequests = pgTable(
  "agent_pull_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    incidentId: uuid("incident_id")
      .notNull()
      .references(() => incidents.id, { onDelete: "cascade" }),
    agentRunId: uuid("agent_run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    installationId: uuid("installation_id")
      .notNull()
      .references(() => githubInstallations.id, { onDelete: "cascade" }),
    repoFullName: text("repo_full_name").notNull(),
    prNumber: integer("pr_number").notNull(),
    prNodeId: text("pr_node_id"),
    url: text("url").notNull(),
    branchName: text("branch_name").notNull(),
    baseBranch: text("base_branch").notNull(),
    headSha: text("head_sha"),
    state: text("state").$type<AgentPrState>().notNull().default("open"),
    title: text("title"),
    mergedAt: timestamp("merged_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    mergedByLogin: text("merged_by_login"),
    mergedByGithubId: bigint("merged_by_github_id", { mode: "number" }),
    // Rejection signals for the PR acceptance-rate metric, written exactly once
    // by the lifecycle sweep (worker jobs/agent-pr-lifecycle.ts) via
    // IS NULL-guarded updates so each signal emits a single analytics event.
    // A 👎 reaction or expiry doesn't change `state` — the PR is still open on
    // GitHub and a later merge supersedes both signals in the metric.
    negativeReactionAt: timestamp("negative_reaction_at", { withTimezone: true }),
    expiredAt: timestamp("expired_at", { withTimezone: true }),
    // Monotonic watermark from GitHub's pull_request.updated_at. Keep this
    // separate from lastSyncedAt: provider timestamps have second precision
    // and may be behind the worker/API host clock used for local reconciliation.
    providerUpdatedAt: timestamp("provider_updated_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    incidentIdx: index("agent_pull_requests_incident_idx").on(t.incidentId, t.createdAt),
    agentRunIdx: index("agent_pull_requests_agent_run_idx").on(t.agentRunId),
    repoPrUniq: uniqueIndex("agent_pull_requests_repo_pr_idx").on(t.repoFullName, t.prNumber),
  }),
);

export const agentPrEvents = pgTable(
  "agent_pr_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentPrId: uuid("agent_pr_id")
      .notNull()
      .references(() => agentPullRequests.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    summary: text("summary"),
    actorLogin: text("actor_login"),
    actorGithubId: bigint("actor_github_id", { mode: "number" }),
    actorAvatarUrl: text("actor_avatar_url"),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    providerEventId: text("provider_event_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    prIdx: index("agent_pr_events_pr_idx").on(t.agentPrId, t.occurredAt),
    providerEventUniq: uniqueIndex("agent_pr_events_provider_event_idx").on(
      t.agentPrId,
      t.providerEventId,
    ),
  }),
);

export type AgentLinearTicketState = "open" | "completed" | "canceled" | "unstarted" | "started";

export const agentLinearTickets = pgTable(
  "agent_linear_tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    incidentId: uuid("incident_id")
      .notNull()
      .references(() => incidents.id, { onDelete: "cascade" }),
    agentRunId: uuid("agent_run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    installationId: uuid("installation_id")
      .notNull()
      .references(() => linearInstallations.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").notNull(),
    ticketId: text("ticket_id").notNull(),
    ticketIdentifier: text("ticket_identifier"),
    url: text("url"),
    title: text("title"),
    state: text("state"),
    stateType: text("state_type").$type<AgentLinearTicketState>(),
    assigneeName: text("assignee_name"),
    assigneeLinearId: text("assignee_linear_id"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    incidentIdx: index("agent_linear_tickets_incident_idx").on(t.incidentId, t.createdAt),
    agentRunIdx: index("agent_linear_tickets_agent_run_idx").on(t.agentRunId),
    workspaceTicketUniq: uniqueIndex("agent_linear_tickets_workspace_ticket_idx").on(
      t.workspaceId,
      t.ticketId,
    ),
  }),
);

export const agentLinearTicketEvents = pgTable(
  "agent_linear_ticket_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentLinearTicketId: uuid("agent_linear_ticket_id")
      .notNull()
      .references(() => agentLinearTickets.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    summary: text("summary"),
    actorName: text("actor_name"),
    actorLinearId: text("actor_linear_id"),
    actorAvatarUrl: text("actor_avatar_url"),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    providerEventId: text("provider_event_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    ticketIdx: index("agent_linear_ticket_events_ticket_idx").on(
      t.agentLinearTicketId,
      t.occurredAt,
    ),
    providerEventUniq: uniqueIndex("agent_linear_ticket_events_provider_event_idx").on(
      t.agentLinearTicketId,
      t.providerEventId,
    ),
  }),
);

// Outgoing-integration model: a webhook is "a message to relay", not a typed
// state-machine event. `incident.created` maps to "post a new message / open a
// new thread"; `incident.updated` maps to "reply in that thread / edit it".
// Everything that used to be a distinct event (resolve, reopen, merge, agent
// started/completed/failed/awaiting) is now an `incident.updated` carrying a
// `change.kind` discriminator plus a render-ready `message` block.
export type WebhookEventType = "incident.created" | "incident.updated";

export const WEBHOOK_EVENT_TYPES: readonly WebhookEventType[] = [
  "incident.created",
  "incident.updated",
] as const;

export function isWebhookEventType(value: unknown): value is WebhookEventType {
  return typeof value === "string" && (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);
}

export type WebhookDeliveryStatus = "pending" | "success" | "failed";

export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    description: text("description"),
    secret: text("secret").notNull(),
    enabledEvents: jsonb("enabled_events")
      .$type<WebhookEventType[]>()
      .notNull()
      .default(sql`'["incident.created","incident.updated"]'::jsonb`),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    projectIdx: index("webhook_endpoints_project_idx").on(t.projectId, t.createdAt),
  }),
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: "cascade" }),
    eventType: text("event_type").$type<WebhookEventType>().notNull(),
    eventId: uuid("event_id").notNull().defaultRandom(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status").$type<WebhookDeliveryStatus>().notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    lastResponseStatus: integer("last_response_status"),
    lastResponseBody: text("last_response_body"),
    lastError: text("last_error"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    endpointIdx: index("webhook_deliveries_endpoint_idx").on(t.endpointId, t.createdAt),
    pendingIdx: index("webhook_deliveries_pending_idx")
      .on(t.nextAttemptAt)
      .where(sql`status = 'pending'`),
  }),
);

export const workerState = pgTable("worker_state", {
  name: text("name").primaryKey(),
  cursor: timestamp("cursor", { withTimezone: true, precision: 6 }).notNull(),
  cursorKey: text("cursor_key").notNull().default("00000000-0000-0000-0000-000000000000"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// Per-org dedup ledger for usage-limit notifications. One row per
// (org, billing period, threshold step) that has already fired, so the worker
// notifier sends each 50/85/100% notice at most once per period. The unique
// index makes the claim atomic: insert ... onConflictDoNothing().returning()
// tells the notifier whether THIS call won the step (→ send) or lost (→ skip).
export const usageNotifications = pgTable(
  "usage_notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    // Billing-period start as "YYYY-MM-DD" (period.ts periodKey) — resets the
    // dedup window each cycle so notifications can fire again next period.
    periodKey: text("period_key").notNull(),
    // 50 | 85 | 100.
    threshold: integer("threshold").notNull(),
    // Which metered feature drove the watermark when this step fired (spans /
    // logs / metric_points / investigations) — recorded for observability.
    feature: text("feature").notNull(),
    notifiedAt: timestamp("notified_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgPeriodThresholdUniq: uniqueIndex("usage_notifications_org_period_threshold_idx").on(
      t.orgId,
      t.periodKey,
      t.threshold,
    ),
  }),
);

export const cliSessions = pgTable("cli_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  orgId: uuid("org_id")
    .notNull()
    .references(() => orgs.id, { onDelete: "cascade" }),
  tokenPrefix: text("token_prefix").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// User-scoped personal access tokens. An alternative to the interactive OAuth
// flow for authenticating to the MCP server: the user mints one in the UI and
// pastes it into their agent as a static `Authorization: Bearer superlog_pat_…`
// header. Bound to a single project (the MCP session's active-project default)
// and to the minting user; `expires_at` NULL means it never expires.
export const personalAccessTokens = pgTable(
  "personal_access_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    scope: text("scope"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index("personal_access_tokens_user_idx").on(t.userId),
    // Supports the project_id FK (cascade on project delete) + project-scoped lookups.
    projectIdx: index("personal_access_tokens_project_idx").on(t.projectId),
  }),
);

export const mcpOauthClients = pgTable("mcp_oauth_clients", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  redirectUris: jsonb("redirect_uris").notNull().$type<string[]>(),
  tokenEndpointAuthMethod: text("token_endpoint_auth_method").notNull().default("none"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const mcpOauthCodes = pgTable(
  "mcp_oauth_codes",
  {
    code: text("code").primaryKey(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => mcpOauthClients.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    redirectUri: text("redirect_uri").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    codeChallengeMethod: text("code_challenge_method").notNull(),
    resource: text("resource").notNull(),
    scope: text("scope"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    clientIdx: index("mcp_oauth_codes_client_idx").on(t.clientId),
  }),
);

export const mcpOauthTokens = pgTable(
  "mcp_oauth_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accessHash: text("access_hash").notNull().unique(),
    refreshHash: text("refresh_hash").unique(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => mcpOauthClients.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    resource: text("resource").notNull(),
    scope: text("scope"),
    accessExpiresAt: timestamp("access_expires_at", {
      withTimezone: true,
    }).notNull(),
    refreshExpiresAt: timestamp("refresh_expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    clientIdx: index("mcp_oauth_tokens_client_idx").on(t.clientId),
    userIdx: index("mcp_oauth_tokens_user_idx").on(t.userId),
  }),
);

export const githubInstallations = pgTable(
  "github_installations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Owning org. Every install belongs to a Superlog org. When the install
    // also has a project_id, it's "project-scoped" (private to that project,
    // all repos available). When project_id is null, it's "org-scoped"
    // (shared across the org's projects via project_github_repos grants).
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    installationId: bigint("installation_id", { mode: "number" }).notNull(),
    accountLogin: text("account_login"),
    accountType: text("account_type"),
    repos: jsonb("repos").$type<{ id: number; fullName: string; private: boolean }[]>(),
    agentEnabled: boolean("agent_enabled").default(true).notNull(),
    // Opt-in PR review bot. Kept separate from agentEnabled because reviewing
    // incoming PRs and opening remediation PRs are independent capabilities.
    observabilityReviewEnabled: boolean("observability_review_enabled").default(false).notNull(),
    repoAccess: jsonb("repo_access").$type<GithubRepoAccess>(),
    commitAuthorName: text("commit_author_name"),
    commitAuthorEmail: text("commit_author_email"),
    commitAuthorGithubLogin: text("commit_author_github_login"),
    commitAuthorGithubId: bigint("commit_author_github_id", { mode: "number" }),
    commitAuthorAvatarUrl: text("commit_author_avatar_url"),
    commitAuthorSetByUserId: uuid("commit_author_set_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    commitAuthorSetAt: timestamp("commit_author_set_at", {
      withTimezone: true,
    }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // Project-scoped installs: at most one active row per (project, install).
    // Partial so revoked rows can coexist (re-installs reuse installation_id).
    projectInstallationUniq: uniqueIndex("github_installations_project_installation_idx")
      .on(t.projectId, t.installationId)
      .where(sql`project_id IS NOT NULL AND revoked_at IS NULL`),
    // Org-scoped installs (project_id NULL): at most one active row per
    // (org, install). Matches semantics where the install belongs to the org
    // and grants are managed via project_github_repos.
    orgInstallationUniq: uniqueIndex("github_installations_org_installation_idx")
      .on(t.orgId, t.installationId)
      .where(sql`project_id IS NULL AND revoked_at IS NULL`),
    orgIdx: index("github_installations_org_idx").on(t.orgId),
  }),
);

// Durable aggregate for one observability review of one immutable PR head.
// Suggestions stay together as JSON because they are published and reaction-
// synced as a unit; a new head gets a new row rather than mutating history.
export const prObservabilityReviews = pgTable(
  "pr_observability_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    installationId: bigint("installation_id", { mode: "number" }).notNull(),
    orgId: uuid("org_id").references(() => orgs.id, { onDelete: "set null" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    repoFullName: text("repo_full_name").notNull(),
    prNumber: integer("pr_number").notNull(),
    headSha: text("head_sha").notNull(),
    status: text("status").$type<PrObservabilityReviewStatus>().notNull().default("queued"),
    summary: text("summary"),
    suggestions: jsonb("suggestions")
      .$type<PrObservabilitySuggestion[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    processedReactionIds: jsonb("processed_reaction_ids")
      .$type<number[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    failureMessage: text("failure_message"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lastReactionSyncedAt: timestamp("last_reaction_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    headUniq: uniqueIndex("pr_observability_reviews_head_idx").on(
      t.repoFullName,
      t.prNumber,
      t.headSha,
    ),
    queuedIdx: index("pr_observability_reviews_queued_idx")
      .on(t.createdAt)
      .where(sql`status = 'queued'`),
    reactionSyncIdx: index("pr_observability_reviews_reaction_sync_idx")
      .on(t.lastReactionSyncedAt, t.completedAt)
      .where(sql`status = 'completed'`),
  }),
);

// Cross-project repo grants for org-scoped installs. When an install is
// org-scoped (project_id NULL on the install row), this table is the only
// way a project gets access to specific repos under that install. Project-
// scoped installs (project_id set) don't need rows here — the project sees
// all repos via the install directly.
export const projectGithubRepos = pgTable(
  "project_github_repos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    installationId: uuid("installation_id")
      .notNull()
      .references(() => githubInstallations.id, { onDelete: "cascade" }),
    githubRepoId: bigint("github_repo_id", { mode: "number" }).notNull(),
    githubRepoFullName: text("github_repo_full_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    projectRepoUniq: uniqueIndex("project_github_repos_project_repo_idx").on(
      t.projectId,
      t.githubRepoId,
    ),
    installationIdx: index("project_github_repos_installation_idx").on(t.installationId),
  }),
);

// Project-local settings for an org-scoped GitHub installation. The shared
// installation row cannot carry project opt-ins: several projects may have
// disjoint repo grants on the same installation.
export const projectGithubInstallationSettings = pgTable(
  "project_github_installation_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    installationId: uuid("installation_id")
      .notNull()
      .references(() => githubInstallations.id, { onDelete: "cascade" }),
    observabilityReviewEnabled: boolean("observability_review_enabled").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    projectInstallationUniq: uniqueIndex("project_github_installation_settings_uniq").on(
      t.projectId,
      t.installationId,
    ),
  }),
);

export const slackInstallations = pgTable(
  "slack_installations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    teamId: text("team_id").notNull(),
    teamName: text("team_name"),
    botUserId: text("bot_user_id"),
    botAccessToken: text("bot_access_token").notNull(),
    scope: text("scope"),
    installedByUserId: uuid("installed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // Per-project routing target — one install = one channel.
    channelId: text("channel_id"),
    channelName: text("channel_name"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    // Set on every (re)authorization — i.e. whenever Slack mints a fresh bot
    // token for this install. The upsert refreshes the token in place on
    // reinstall, so `createdAt` does NOT track token-refresh recency;
    // `installedAt` does. A workspace installed into several projects owns one
    // non-revoked row per project but Slack keeps only the most-recently-minted
    // bot token live, so when we must pick by team the highest `installedAt`
    // wins. (Incident/proposal flows should still prefer the pinned install.)
    //
    // Nullable on purpose: rows that predate this column have no recorded
    // refresh time (and `createdAt` is itself unreliable for in-place token
    // refreshes), so we leave them NULL and `coalesce(installedAt, createdAt)`
    // at query time rather than stamping every legacy row with the same
    // migration timestamp. Every write below sets it explicitly.
    installedAt: timestamp("installed_at", { withTimezone: true }),
    // When a workspace is connected to several Superlog projects, a bot
    // mention outside any project's routed channel is ambiguous. This flags
    // the one project that answers those; the partial unique index enforces
    // at most one default per workspace.
    isDefaultChatProject: boolean("is_default_chat_project").notNull().default(false),
  },
  (t) => ({
    projectTeamUniq: uniqueIndex("slack_installations_project_team_idx").on(t.projectId, t.teamId),
    defaultChatProjectUniq: uniqueIndex("slack_installations_default_chat_idx")
      .on(t.teamId)
      .where(sql`is_default_chat_project`),
  }),
);

export type DashboardWidgetType =
  | "timeseries_count"
  | "timeseries_metric"
  | "trace_table"
  | "log_table"
  | "markdown";

export type DashboardWidgetConfig = {
  source?: "logs" | "traces";
  filter: {
    resourceAttrs?: {
      key: string;
      value: string;
      op?: "eq" | "neq" | "not_contains";
    }[];
  };
  groupBy?: string;
  metricName?: string;
  aggregation?: "sum" | "avg" | "min" | "max" | "p95" | "p99";
  limit?: number;
  chartType?: "line" | "bar";
  showXAxis?: boolean;
  showYAxis?: boolean;
  showLegend?: boolean;
  markdown?: string;
};

export type DashboardWidgetLayout = {
  x: number;
  y: number;
  w: number;
  h: number;
};

// A dashboard-level template variable. Filters reference it from a widget's
// `resourceAttrs[].value` with the token `$name` (or `${name}`); at view time
// the dashboard substitutes the currently-selected option before querying.
// `options` is the configurable picklist shown in the dashboard's variable bar.
// `attributeKey`, when set, is a convenience that lets the widget editor offer a
// one-click "filter by this variable" on that attribute — the variable can
// still be referenced from a filter on any key via `$name`.
export type DashboardVariable = {
  name: string;
  label?: string;
  options: string[];
  defaultValue?: string;
  attributeKey?: string;
};

export type SavedExploreViewState = {
  source: "logs" | "traces";
  range:
    | { type: "relative"; seconds: number; label: string }
    | { type: "absolute"; since: string; until: string };
  attrs: { key: string; value: string }[];
  severity?: string;
  statusCode?: string;
  groupBy?: string;
  tracesView?: "traces" | "spans";
};

export const savedViews = pgTable(
  "saved_views",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    visibility: text("visibility").$type<"personal" | "workspace">().notNull(),
    state: jsonb("state").$type<SavedExploreViewState>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    projectIdx: index("saved_views_project_idx").on(t.projectId),
    creatorIdx: index("saved_views_creator_idx").on(t.createdByUserId),
  }),
);

export const dashboards = pgTable(
  "dashboards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    variables: jsonb("variables").$type<DashboardVariable[]>().notNull().default(sql`'[]'::jsonb`),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    projectSlugUniq: uniqueIndex("dashboards_project_slug_idx").on(t.projectId, t.slug),
    projectIdx: index("dashboards_project_idx").on(t.projectId),
  }),
);

export const dashboardWidgets = pgTable(
  "dashboard_widgets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dashboardId: uuid("dashboard_id")
      .notNull()
      .references(() => dashboards.id, { onDelete: "cascade" }),
    type: text("type").$type<DashboardWidgetType>().notNull(),
    title: text("title").notNull(),
    config: jsonb("config").$type<DashboardWidgetConfig>().notNull(),
    layout: jsonb("layout").$type<DashboardWidgetLayout>().notNull(),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    dashboardIdx: index("dashboard_widgets_dashboard_idx").on(t.dashboardId),
  }),
);

export const linearInstallations = pgTable(
  "linear_installations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").notNull(),
    workspaceName: text("workspace_name"),
    workspaceUrlKey: text("workspace_url_key"),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    actorEmail: text("actor_email"),
    appUserId: text("app_user_id"),
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token"),
    accessExpiresAt: timestamp("access_expires_at", { withTimezone: true }),
    scope: text("scope"),
    anthropicVaultId: text("anthropic_vault_id"),
    anthropicCredentialId: text("anthropic_credential_id"),
    webhookId: text("webhook_id"),
    webhookSecret: text("webhook_secret"),
    reauthRequiredAt: timestamp("reauth_required_at", { withTimezone: true }),
    reauthReason: text("reauth_reason"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    activeUniq: uniqueIndex("linear_installations_project_active_idx")
      .on(t.projectId)
      .where(sql`revoked_at IS NULL`),
  }),
);

// Linear's AgentSession is the provider-side conversation envelope created
// when the app is mentioned or delegated an issue. This anti-corruption table
// maps that envelope to exactly one local aggregate: Q&A chat for a mention,
// incident for a delegation. The issue itself remains the incident's external
// root and is also recorded as the run's known Linear ticket.
export const linearAgentSessions = pgTable(
  "linear_agent_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    installationId: uuid("installation_id")
      .notNull()
      .references(() => linearInstallations.id, { onDelete: "cascade" }),
    agentSessionId: text("agent_session_id").notNull(),
    kind: text("kind").$type<"chat" | "incident">().notNull(),
    issueId: text("issue_id").notNull(),
    issueIdentifier: text("issue_identifier"),
    issueTitle: text("issue_title"),
    issueUrl: text("issue_url"),
    incidentId: uuid("incident_id").references(() => incidents.id, { onDelete: "cascade" }),
    agentChatId: uuid("agent_chat_id").references(() => agentChats.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    installationSessionUniq: uniqueIndex("linear_agent_sessions_install_session_idx").on(
      t.installationId,
      t.agentSessionId,
    ),
    incidentUniq: uniqueIndex("linear_agent_sessions_incident_idx")
      .on(t.incidentId)
      .where(sql`incident_id IS NOT NULL`),
    chatUniq: uniqueIndex("linear_agent_sessions_chat_idx")
      .on(t.agentChatId)
      .where(sql`agent_chat_id IS NOT NULL`),
    rootCheck: check(
      "linear_agent_sessions_root_check",
      sql`(kind = 'chat' AND agent_chat_id IS NOT NULL AND incident_id IS NULL) OR (kind = 'incident' AND incident_id IS NOT NULL AND agent_chat_id IS NULL)`,
    ),
  }),
);

export const notionInstallations = pgTable(
  "notion_installations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // Notion returns a bot-scoped access token per workspace grant. Tokens do
    // not expire and the classic OAuth flow issues no refresh token, so there's
    // no expiry/refresh bookkeeping here — a revoked grant surfaces as a 401 on
    // use, which flips reauth_required_at.
    botId: text("bot_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    workspaceName: text("workspace_name"),
    workspaceIcon: text("workspace_icon"),
    accessToken: text("access_token").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    actorEmail: text("actor_email"),
    reauthRequiredAt: timestamp("reauth_required_at", { withTimezone: true }),
    reauthReason: text("reauth_reason"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    activeUniq: uniqueIndex("notion_installations_project_active_idx")
      .on(t.projectId)
      .where(sql`revoked_at IS NULL`),
  }),
);

export const orgAgentSettings = pgTable(
  "org_agent_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    customInstructions: text("custom_instructions").notNull().default(""),
    agentRunEnabled: boolean("agent_run_enabled").notNull().default(true),
    linearTicketPolicy: text("linear_ticket_policy")
      .$type<"never" | "on_ready_to_pr" | "always">()
      .notNull()
      .default("on_ready_to_pr"),
    prPolicy: text("pr_policy")
      .$type<"never" | "on_ready_to_pr" | "always">()
      .notNull()
      .default("on_ready_to_pr"),
    digestEnabled: boolean("digest_enabled").notNull().default(false),
    digestSlackInstallationId: uuid("digest_slack_installation_id").references(
      (): AnyPgColumn => slackInstallations.id,
      { onDelete: "set null" },
    ),
    digestSlackChannelId: text("digest_slack_channel_id"),
    digestSlackChannelName: text("digest_slack_channel_name"),
    digestLastRunAt: timestamp("digest_last_run_at", { withTimezone: true }),
    // A one-shot command consumed by the worker. Unlike digestEnabled, this
    // requests one immediate test delivery without changing the weekly policy.
    digestRunRequestedAt: timestamp("digest_run_requested_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgUniq: uniqueIndex("org_agent_settings_org_idx").on(t.orgId),
  }),
);

export type AgentMemoryKind = "feedback" | "terminology" | "infra" | "project";
export type AgentMemoryStatus = "active" | "archived";

// Durable facts the investigation agent carries across runs: terminology,
// infra/project structure, and lessons from user feedback or conversations.
// Memories are strictly project-scoped — each project's investigations see
// only that project's memories. Active ones are injected into every run's
// initial prompt; the agent writes new ones via the save_memory /
// update_memory tools, and users manage them from project settings.
export const agentMemories = pgTable(
  "agent_memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind").$type<AgentMemoryKind>().notNull().default("project"),
    title: text("title").notNull(),
    body: text("body").notNull(),
    status: text("status").$type<AgentMemoryStatus>().notNull().default("active"),
    // Provenance: exactly one of these is set for agent- vs user-authored
    // memories; both stay null only for system backfills.
    sourceAgentRunId: uuid("source_agent_run_id").references(() => agentRuns.id, {
      onDelete: "set null",
    }),
    sourceUserId: uuid("source_user_id").references(() => users.id, { onDelete: "set null" }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgStatusIdx: index("agent_memories_org_status_idx").on(t.orgId, t.status),
    // The project must belong to the same org. Backed by the
    // projects_id_org_uniq constraint on projects (added in its own earlier
    // migration — this FK depends on it).
    projectOrgFk: foreignKey({
      name: "agent_memories_project_org_fk",
      columns: [t.projectId, t.orgId],
      foreignColumns: [projects.id, projects.orgId],
    }).onDelete("cascade"),
    // At most one author: agent-run provenance or user provenance, never both.
    // Both may be null — ON DELETE SET NULL on either source requires it.
    singleSourceCheck: check(
      "agent_memories_single_source_check",
      sql`NOT (source_agent_run_id IS NOT NULL AND source_user_id IS NOT NULL)`,
    ),
  }),
);

export type LinearTicketPolicy = "never" | "on_ready_to_pr" | "always";
export type PrPolicy = "never" | "on_ready_to_pr" | "always";
export type AutoMergePolicy = "never" | "when_checks_pass" | "immediately";
export type AutoMergeMethod = "squash" | "merge" | "rebase";
export const PR_BASE_BRANCH_MAX_LENGTH = 200;

export function normalizePrBaseBranch(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

export function isValidPrBaseBranch(value: string): boolean {
  const branch = normalizePrBaseBranch(value);
  if (!branch) return true;
  if (branch.length > PR_BASE_BRANCH_MAX_LENGTH) return false;
  if (branch === "@" || branch.startsWith("/") || branch.endsWith("/")) return false;
  if (branch.endsWith(".") || branch.includes("..") || branch.includes("//")) return false;
  if (branch.includes("@{")) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Git ref names reject ASCII control bytes.
  if (/[\s~^:?*[\\\]\x00-\x1f\x7f]/.test(branch)) return false;
  return branch
    .split("/")
    .every((part) => part && !part.startsWith(".") && !part.endsWith(".lock"));
}

export type LinearTicketInstruction = {
  id: string;
  title: string;
  text: string;
};

export type IssueFilterClause = { key: string; value: string };

// Four independent buckets. Per kind (log / span):
//   - Excludes win: an event matching ANY exclude-clause for its kind is dropped.
//   - Includes are OR-within-bucket: if the include list for that kind is
//     non-empty, the event must match at least one clause.
//   - Empty include list = no include constraint (allow by default).
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

export type IntegrationSecretSpec = {
  name: string;
  description: string;
};

export type IntegrationOperation = {
  name: string;
  description: string;
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  input_schema: Record<string, unknown>;
  path_template?: Record<string, string>;
  query_template?: Record<string, string>;
  body_template?: Record<string, unknown>;
  response_filter?: string[];
  rate_limit_per_session?: number;
  docs_only?: boolean;
};

export type IntegrationDefinition = {
  slug: string;
  name: string;
  description: string;
  base_url: string;
  default_headers: Record<string, string>;
  required_secrets: IntegrationSecretSpec[];
  operations: IntegrationOperation[];
};

export const orgIntegrations = pgTable(
  "org_integrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgSlugUniq: uniqueIndex("org_integrations_org_slug_idx").on(t.orgId, t.slug),
    orgEnabledIdx: index("org_integrations_org_enabled_idx").on(t.orgId).where(sql`enabled`),
  }),
);

export const orgIntegrationSecrets = pgTable(
  "org_integration_secrets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgIntegrationId: uuid("org_integration_id")
      .notNull()
      .references(() => orgIntegrations.id, { onDelete: "cascade" }),
    secretName: text("secret_name").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    nonce: bytea("nonce").notNull(),
    keyVersion: integer("key_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    nameUniq: uniqueIndex("org_integration_secrets_unique_idx").on(
      t.orgIntegrationId,
      t.secretName,
    ),
  }),
);

export const sourceMapArtifacts = pgTable(
  "source_map_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    release: text("release").notNull(),
    dist: text("dist"),
    debugId: text("debug_id"),
    bundleFile: text("bundle_file"),
    mapFile: text("map_file").notNull(),
    sourceMapHash: text("source_map_hash").notNull(),
    sourceMapBytes: integer("source_map_bytes").notNull(),
    storageBucket: text("storage_bucket").notNull(),
    storageKey: text("storage_key").notNull(),
    contentEncoding: text("content_encoding").notNull().default("gzip"),
    uploadedByOrgApiKeyId: uuid("uploaded_by_org_api_key_id").references(() => orgApiKeys.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    debugIdUniq: uniqueIndex("source_map_artifacts_project_debug_id_idx")
      .on(t.projectId, t.debugId)
      .where(sql`debug_id IS NOT NULL`),
    releaseIdx: index("source_map_artifacts_project_release_idx").on(
      t.projectId,
      t.platform,
      t.release,
      t.dist,
    ),
  }),
);

export type AlertSource = "logs" | "traces" | "metric";
export type AlertAggregation = "count" | "sum" | "avg";
export type AlertComparator = "gt" | "lt";
export type AlertGroupMode = "per_group" | "single";

export type AlertFilter = {
  resourceAttrs?: { key: string; value: string }[];
  service?: string;
  severity?: string;
  spanName?: string;
  statusCode?: string;
  minDurationMs?: number;
};

export const alerts = pgTable(
  "alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    source: text("source").$type<AlertSource>().notNull(),
    metricName: text("metric_name"),
    filter: jsonb("filter").$type<AlertFilter>().notNull().default(sql`'{}'::jsonb`),
    groupBy: text("group_by"),
    groupMode: text("group_mode").$type<AlertGroupMode>().notNull().default("single"),
    aggregation: text("aggregation").$type<AlertAggregation>().notNull(),
    comparator: text("comparator").$type<AlertComparator>().notNull(),
    threshold: doublePrecision("threshold").notNull(),
    windowMinutes: integer("window_minutes").notNull().default(5),
    evaluationIntervalSeconds: integer("evaluation_interval_seconds").notNull().default(60),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    lastEvaluatedAt: timestamp("last_evaluated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    projectIdx: index("alerts_project_idx").on(t.projectId),
    enabledIdx: index("alerts_enabled_idx").on(t.enabled, t.lastEvaluatedAt).where(sql`enabled`),
  }),
);

export const alertFirings = pgTable(
  "alert_firings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    alertId: uuid("alert_id")
      .notNull()
      .references(() => alerts.id, { onDelete: "cascade" }),
    groupKey: text("group_key").notNull().default(""),
    state: text("state").$type<"firing" | "ok">().notNull(),
    observedValue: doublePrecision("observed_value").notNull(),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).notNull(),
    issueId: uuid("issue_id").references(() => issues.id, {
      onDelete: "set null",
    }),
  },
  (t) => ({
    alertGroupIdx: index("alert_firings_alert_group_idx").on(t.alertId, t.groupKey, t.evaluatedAt),
  }),
);

// One row per *contiguous* activation of an alert — an "episode". Where
// `alert_firings` is the raw per-evaluation-tick log, an episode collapses the
// run of consecutive `firing` ticks (for a given alert + groupKey) into a
// single record: it opens on the `new_firing` transition and closes on
// `recovered`. Each episode points at the issue it raised and the incident /
// agent runs that issue produced, and the incident links back via
// `incident_id`. The partial unique index guarantees at most one open episode
// per (alert, group) at a time.
//
// Episode rows are written best-effort by the alert evaluation loop: a failure
// to open/close an episode must never block the paging-critical issue/incident
// path, so they're decoupled from `recordFiring`/`markEvaluated`.
export const alertEpisodes = pgTable(
  "alert_episodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    alertId: uuid("alert_id")
      .notNull()
      .references(() => alerts.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    groupKey: text("group_key").notNull().default(""),
    state: text("state").$type<"firing" | "resolved">().notNull().default("firing"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    // Observed aggregate value at the moment the episode opened.
    openObservedValue: doublePrecision("open_observed_value").notNull(),
    // Most-severe value seen across the episode (max for `gt` alerts, min for
    // `lt`), maintained on each still-firing tick.
    peakObservedValue: doublePrecision("peak_observed_value").notNull(),
    // Value from the latest tick within the episode.
    lastObservedValue: doublePrecision("last_observed_value").notNull(),
    // Timestamp of the latest firing tick (advances while the episode is open).
    lastFiringAt: timestamp("last_firing_at", { withTimezone: true }).notNull(),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    incidentId: uuid("incident_id").references(() => incidents.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    alertStartedIdx: index("alert_episodes_alert_started_idx").on(t.alertId, t.startedAt),
    incidentIdx: index("alert_episodes_incident_idx").on(t.incidentId),
    openUniq: uniqueIndex("alert_episodes_open_uniq")
      .on(t.alertId, t.groupKey)
      .where(sql`state = 'firing'`),
    // An issue is 1:1 with an episode (one breach period = one issue); this is
    // also the reverse-lookup path from an issue to its episode.
    issueUniq: uniqueIndex("alert_episodes_issue_uniq")
      .on(t.issueId)
      .where(sql`issue_id IS NOT NULL`),
  }),
);

// User-submitted feedback. One table for every surface (in-app dialog on
// incidents/issues, link in our agent-opened PRs, non-bot review comments
// on those PRs, and the "Give feedback" button on Slack incident threads).
// Polled by `/admin/feedback`; every insert also fires a Slack notification
// to a configured FEEDBACK_SLACK_WEBHOOK so we hear about it in real time.
//
// `kind` + `refId` together identify what the feedback is about; for
// `kind='pr'` we also store `refRepo` so admins can land on the right repo
// without re-resolving. `authorUserId` is set when a Superlog user submitted
// the feedback signed-in; `authorExternal` holds GitHub login or Slack user
// id otherwise (PR webhook captures, /feedback/pr/* public submissions, and
// Slack view_submission events all come in without a session).
export type FeedbackKind = "incident" | "issue" | "pr";
export type FeedbackSource =
  | "dialog"
  | "slack_button"
  | "slack_rating"
  | "pr_comment"
  | "pr_link"
  | "pr_review_reaction";
export type FeedbackStatus = "new" | "triaged" | "closed";
// One-click sentiment on an incident's Slack thread (👍/👎). Nullable — most
// feedback rows carry only free-form `body` with no structured rating.
export type FeedbackRating = "helpful" | "unhelpful";
export type FeedbackAuthorExternal = {
  githubLogin?: string;
  githubCommentUrl?: string;
  slackUserId?: string;
  slackTeamId?: string;
};

export const feedback = pgTable(
  "feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").$type<FeedbackKind>().notNull(),
    refId: text("ref_id").notNull(),
    refRepo: text("ref_repo"),
    source: text("source").$type<FeedbackSource>().notNull(),
    // Stable provider event id for polling-based integrations. GitHub does not
    // emit reaction webhooks, so the review worker polls and uses this key to
    // make feedback inserts idempotent across job retries.
    providerEventId: text("provider_event_id"),
    body: text("body").notNull(),
    rating: text("rating").$type<FeedbackRating>(),
    authorUserId: uuid("author_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    authorExternal: jsonb("author_external").$type<FeedbackAuthorExternal>(),
    orgId: uuid("org_id").references(() => orgs.id, { onDelete: "set null" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    status: text("status").$type<FeedbackStatus>().notNull().default("new"),
    triagedByUserId: uuid("triaged_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    triagedAt: timestamp("triaged_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    statusCreatedIdx: index("feedback_status_created_idx").on(t.status, t.createdAt),
    kindRefIdx: index("feedback_kind_ref_idx").on(t.kind, t.refId),
    providerEventUniq: uniqueIndex("feedback_provider_event_idx")
      .on(t.providerEventId)
      .where(sql`provider_event_id IS NOT NULL`),
  }),
);

/**
 * Status of a customer AWS connection. `pending` until the customer deploys the
 * CloudFormation stack and we successfully assume the scrape role;
 * `account_mismatch` if the assumed identity resolves to a different account than
 * the role ARN names; `failed` if the role can't be assumed.
 */
export type CloudConnectionStatus = "pending" | "connected" | "account_mismatch" | "failed";

export const cloudConnections = pgTable(
  "cloud_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // Region the connection's CloudFormation stack lives in (metric streams /
    // Firehose are regional). Single-region per connection for v1.
    region: text("region").notNull(),
    // Read-only scrape/metrics role assumed for inventory + stack provisioning.
    // Null until the customer deploys the stack and reports the role ARN at verify
    // (the role doesn't exist before deploy; the external ID below is minted first
    // because it has to go *into* the stack).
    scrapeRoleArn: text("scrape_role_arn"),
    // The trust-policy external ID, encrypted at rest (confused-deputy guard).
    externalIdCiphertext: bytea("external_id_ciphertext").notNull(),
    externalIdNonce: bytea("external_id_nonce").notNull(),
    externalIdKeyVersion: integer("external_id_key_version").notNull().default(1),
    // Set on the first successful verify, from the assumed caller identity.
    accountId: text("account_id"),
    status: text("status").$type<CloudConnectionStatus>().notNull().default("pending"),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => ({
    projectIdx: index("cloud_connections_project_idx").on(t.projectId),
    // One live connection per (project, scrape role) — re-connecting the same role
    // revokes the old row first (see the upsert in cloud-connections.ts).
    activeRoleUniq: uniqueIndex("cloud_connections_active_role_idx")
      .on(t.projectId, t.scrapeRoleArn)
      .where(sql`revoked_at IS NULL`),
  }),
);

export const cloudResources = pgTable(
  "cloud_resources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // Which connection discovered this resource (a project may connect several).
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => cloudConnections.id, { onDelete: "cascade" }),
    arn: text("arn").notNull(),
    // Derived from the ARN: service (e.g. "ec2"), resource type (e.g. "instance").
    service: text("service").notNull(),
    resourceType: text("resource_type"),
    region: text("region"),
    accountId: text("account_id"),
    // Best-effort display name (the `Name` tag, else the ARN's resource id).
    name: text("name"),
    tags: jsonb("tags").$type<Record<string, string>>(),
    // Raw ResourceGroupsTaggingAPI mapping, for fields we don't model yet.
    raw: jsonb("raw"),
    // Resource configuration from the Cloud Control API (best-effort; null for
    // types Cloud Control doesn't support or that we don't enrich). Never holds
    // secret values — the scrape role can't read those.
    config: jsonb("config"),
    configFetchedAt: timestamp("config_fetched_at", { withTimezone: true }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
    // Set when a sync no longer sees the resource (deleted in AWS); cleared if it
    // reappears. Kept as a soft-delete so history/grouping survive transient drops.
    removedAt: timestamp("removed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    projectArnUniq: uniqueIndex("cloud_resources_project_arn_idx").on(t.projectId, t.arn),
    projectIdx: index("cloud_resources_project_idx").on(t.projectId),
    connectionIdx: index("cloud_resources_connection_idx").on(t.connectionId),
  }),
);

// The dedicated ingest key minted for a connection's metric/log stream, stored
// encrypted so re-launching ("repair") reuses the *same* key instead of minting
// a new one each time — the idempotency the reconciliation UI relies on. One row
// per (connection, kind); the matching api_keys row carries last_used_at, which
// is the "records actually arriving" signal.
export const cloudStreamKeys = pgTable(
  "cloud_stream_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => cloudConnections.id, { onDelete: "cascade" }),
    // "metrics" (CloudWatch Metric Streams) or "logs" (account-level subscription).
    kind: text("kind").$type<"metrics" | "logs">().notNull(),
    // The minted ingest key this stream authenticates with.
    apiKeyId: uuid("api_key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    // The key's plaintext, encrypted at rest (same scheme as the external ID), so
    // the launch URL can re-embed it on repair without re-minting.
    keyCiphertext: bytea("key_ciphertext").notNull(),
    keyNonce: bytea("key_nonce").notNull(),
    keyKeyVersion: integer("key_key_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    connectionKindUniq: uniqueIndex("cloud_stream_keys_connection_kind_idx").on(
      t.connectionId,
      t.kind,
    ),
  }),
);

export type CloudStreamKey = typeof cloudStreamKeys.$inferSelect;

export type GcpAuthorizationStatus = "pending" | "ready" | "consumed" | "failed";

export type GcpAuthorizationProject = {
  projectId: string;
  projectNumber: string;
  displayName: string;
};

/**
 * A short-lived, user-bound Google OAuth grant used only between project
 * discovery and the user's explicit selection. Access tokens are encrypted,
 * never returned to the browser, cleared on first use, and expire after ten
 * minutes in the ready state. Refresh tokens are never requested or stored.
 */
export const gcpAuthorizationSessions = pgTable(
  "gcp_authorization_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: text("status").$type<GcpAuthorizationStatus>().notNull().default("pending"),
    projects: jsonb("projects").$type<GcpAuthorizationProject[]>().notNull().default([]),
    accessTokenCiphertext: bytea("access_token_ciphertext"),
    accessTokenNonce: bytea("access_token_nonce"),
    accessTokenKeyVersion: integer("access_token_key_version"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    projectIdx: index("gcp_authorization_sessions_project_idx").on(t.projectId),
    userIdx: index("gcp_authorization_sessions_user_idx").on(t.userId),
    expiryIdx: index("gcp_authorization_sessions_expiry_idx").on(t.expiresAt),
  }),
);

export type GcpAuthorizationSession = typeof gcpAuthorizationSessions.$inferSelect;

/**
 * A customer GCP project connected to a Superlog project. No user OAuth token
 * is retained on the durable connection: setup consumes the separate,
 * short-lived authorization session and discards its encrypted token. Pub/Sub
 * resources live in the integration operator's GCP project, so their metered
 * usage is not charged to the customer project.
 */
export type GcpConnectionStatus = "pending" | "provisioning" | "connected" | "failed";

export const gcpConnections = pgTable(
  "gcp_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    gcpProjectId: text("gcp_project_id").notNull(),
    gcpProjectNumber: text("gcp_project_number"),
    status: text("status").$type<GcpConnectionStatus>().notNull().default("pending"),
    // Names of the per-connection resources owned by the integration project.
    topicName: text("topic_name"),
    subscriptionName: text("subscription_name"),
    // Customer-owned route and the Google-managed identity that publishes it.
    logSinkName: text("log_sink_name"),
    logSinkWriterIdentity: text("log_sink_writer_identity"),
    // Ownership provenance: only remove the monitoring grant on replacement
    // when this connection originally created it.
    monitoringViewerGrantCreated: boolean("monitoring_viewer_grant_created")
      .notNull()
      .default(false),
    // Persisted for audit/display only; this is our read-only identity, not a
    // customer secret or key.
    readerServiceAccountEmail: text("reader_service_account_email").notNull(),
    apiKeyId: uuid("api_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
    ingestKeyCiphertext: bytea("ingest_key_ciphertext"),
    ingestKeyNonce: bytea("ingest_key_nonce"),
    ingestKeyKeyVersion: integer("ingest_key_key_version"),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    lastLogReceivedAt: timestamp("last_log_received_at", { withTimezone: true }),
    lastMetricsReceivedAt: timestamp("last_metrics_received_at", { withTimezone: true }),
    // Legacy summary checkpoint retained for status display; delivery uses the
    // per-metric map so a faster metric cannot hide a lagging metric type.
    metricsCursor: timestamp("metrics_cursor", { withTimezone: true }),
    metricsCursors: jsonb("metrics_cursors").$type<Record<string, string>>(),
    // Monthly returned-series counter enforces the customer cost ceiling.
    metricsBudgetMonth: text("metrics_budget_month"),
    metricsSeriesRead: bigint("metrics_series_read", { mode: "number" }).notNull().default(0),
    lastError: text("last_error"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    projectIdx: index("gcp_connections_project_idx").on(t.projectId),
    customerProjectIdx: index("gcp_connections_customer_project_idx").on(t.gcpProjectId),
    activeProjectCustomerUniq: uniqueIndex("gcp_connections_active_project_customer_idx")
      .on(t.projectId, t.gcpProjectId)
      .where(sql`revoked_at IS NULL`),
  }),
);

export type GcpConnection = typeof gcpConnections.$inferSelect;

// A connected Cloudflare account via self-managed OAuth (GA 2026-06). One row per
// (project, Cloudflare account). Access/refresh tokens are encrypted at rest with
// the same AES-256-GCM scheme as the AWS-connect external ID. On connect we use
// the granted token to create Workers Observability telemetry destinations that
// export OTLP traces/logs/metrics to our intake authenticated by a project ingest
// key, so the customer's Workers telemetry flows into Superlog with no copy-paste.
export const cloudflareInstallations = pgTable(
  "cloudflare_installations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // The Cloudflare account the user consented to (account-scoped APIs need it).
    accountId: text("account_id").notNull(),
    accountName: text("account_name"),
    // Delegated OAuth tokens, encrypted at rest. Refresh token is nullable: it's
    // only issued when the client is registered with the `refresh_token` grant.
    accessTokenCiphertext: bytea("access_token_ciphertext").notNull(),
    accessTokenNonce: bytea("access_token_nonce").notNull(),
    accessTokenKeyVersion: integer("access_token_key_version").notNull().default(1),
    refreshTokenCiphertext: bytea("refresh_token_ciphertext"),
    refreshTokenNonce: bytea("refresh_token_nonce"),
    refreshTokenKeyVersion: integer("refresh_token_key_version"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    // The ingest key the created destinations authenticate with, stored encrypted
    // (same scheme as cloud_stream_keys) so a re-sync reuses the same key instead
    // of minting a new one each connect.
    apiKeyId: uuid("api_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
    ingestKeyCiphertext: bytea("ingest_key_ciphertext"),
    ingestKeyNonce: bytea("ingest_key_nonce"),
    ingestKeyKeyVersion: integer("ingest_key_key_version"),
    // The Workers Observability destinations we created, keyed by signal:
    // { traces, logs, metrics } → Cloudflare destination slug.
    destinations: jsonb("destinations").$type<Record<string, string>>(),
    // When true, a periodic reconcile keeps every Worker in the account wired to
    // our destinations — including workers created, recreated, or renamed after
    // connect (which come up unwired and would otherwise go dark). Default on:
    // connect already wires everything once, so "on" preserves that intent and
    // makes it durable. Off = the account owner manages wiring manually via the
    // Workers list.
    autoWire: boolean("auto_wire").notNull().default(true),
    installedByUserId: uuid("installed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // One live install per (project, Cloudflare account); reconnecting refreshes
    // the same row (see the upsert in apps/api/src/cloudflare.ts). This composite
    // unique index also serves project-scoped lookups via its left-most
    // `project_id` prefix, so no separate single-column project index is needed.
    projectAccountUniq: uniqueIndex("cloudflare_installations_project_account_idx").on(
      t.projectId,
      t.accountId,
    ),
  }),
);

export type CloudflareInstallation = typeof cloudflareInstallations.$inferSelect;

// A connected Vercel account via a connectable-account integration install.
// One row per (project, integration configuration) — Vercel issues a
// configuration id (`icfg_…`) per install and the long-lived OAuth token is
// scoped to it. On connect we use the token to create a Drain that streams the
// team's deployments' OTLP traces to our intake authenticated by a project
// ingest key, so the customer's Vercel telemetry flows into Superlog with no
// copy-paste. Tokens/keys are encrypted at rest with the same AES-256-GCM
// scheme as the Cloudflare connector.
export const vercelInstallations = pgTable(
  "vercel_installations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // The integration configuration the token is scoped to (`icfg_…`).
    configurationId: text("configuration_id").notNull(),
    // Null for personal-account installs; team installs need it as `?teamId=`
    // on every API call.
    teamId: text("team_id"),
    teamName: text("team_name"),
    // Long-lived delegated OAuth token, encrypted at rest (Vercel integration
    // tokens have no refresh token / expiry).
    accessTokenCiphertext: bytea("access_token_ciphertext").notNull(),
    accessTokenNonce: bytea("access_token_nonce").notNull(),
    accessTokenKeyVersion: integer("access_token_key_version").notNull().default(1),
    // The ingest key the created drain authenticates with, stored encrypted so
    // a re-sync reuses the same key instead of minting a new one each connect.
    apiKeyId: uuid("api_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
    ingestKeyCiphertext: bytea("ingest_key_ciphertext"),
    ingestKeyNonce: bytea("ingest_key_nonce"),
    ingestKeyKeyVersion: integer("ingest_key_key_version"),
    // The Drains we created, keyed by signal: { traces, logs } → Vercel drain id.
    drains: jsonb("drains").$type<Record<string, string>>(),
    installedByUserId: uuid("installed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // One live install per (project, configuration); a replayed callback for the
    // same configuration refreshes the row (see the upsert in
    // apps/api/src/vercel.ts). Also serves project-scoped lookups via its
    // left-most `project_id` prefix.
    projectConfigurationUniq: uniqueIndex("vercel_installations_project_configuration_idx").on(
      t.projectId,
      t.configurationId,
    ),
  }),
);

export type VercelInstallation = typeof vercelInstallations.$inferSelect;

// A connected Railway account via "Login with Railway" OAuth. One row per
// (project, Railway user) — Railway has no per-grant id, so the OIDC `sub` of
// the consenting user is the stable install key; a re-consent by the same user
// refreshes the row. Unlike the Vercel/Cloudflare connectors there is nothing
// to provision on Railway's side: Railway has no drains, so a worker-side
// puller reads logs (GraphQL subscription/query) and metrics (query) from the
// granted projects and forwards them to our intake authenticated by the
// project ingest key. Access tokens live 1h; the rotating refresh token is
// re-persisted on every refresh. Tokens/keys are encrypted at rest with the
// same AES-256-GCM scheme as the Cloudflare connector.
export const railwayInstallations = pgTable(
  "railway_installations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // OIDC `sub` of the Railway user who consented — the stable install key.
    railwayUserId: text("railway_user_id").notNull(),
    // Snapshot of what the grant can see (from `externalWorkspaces`), refreshed
    // by the puller: workspaces and the granted projects with their
    // environments. Display + pull-planning only, never authorization.
    grantedProjects:
      jsonb("granted_projects").$type<
        Array<{
          id: string;
          name: string;
          workspaceId: string | null;
          workspaceName: string | null;
        }>
      >(),
    // Delegated OAuth tokens, encrypted at rest. Railway access tokens expire
    // after ~1h; refresh tokens rotate on every use (the puller persists the
    // replacement immediately). Refresh token nullable: consent without
    // `offline_access` yields none and the install degrades at expiry.
    accessTokenCiphertext: bytea("access_token_ciphertext").notNull(),
    accessTokenNonce: bytea("access_token_nonce").notNull(),
    accessTokenKeyVersion: integer("access_token_key_version").notNull().default(1),
    refreshTokenCiphertext: bytea("refresh_token_ciphertext"),
    refreshTokenNonce: bytea("refresh_token_nonce"),
    refreshTokenKeyVersion: integer("refresh_token_key_version"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    // The ingest key the puller forwards telemetry with, stored encrypted so a
    // re-connect reuses the same key instead of minting a new one.
    apiKeyId: uuid("api_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
    ingestKeyCiphertext: bytea("ingest_key_ciphertext"),
    ingestKeyNonce: bytea("ingest_key_nonce"),
    ingestKeyKeyVersion: integer("ingest_key_key_version"),
    // Puller checkpoint: Railway environment id → RFC3339 timestamp of the last
    // forwarded log line, so restarts resume without gaps or duplicates.
    logCursor: jsonb("log_cursor").$type<Record<string, string>>(),
    // Puller checkpoint for metrics: Railway service id → epoch seconds of the
    // last forwarded sample.
    metricsCursor: jsonb("metrics_cursor").$type<Record<string, number>>(),
    installedByUserId: uuid("installed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // One live install per (project, Railway user); a re-consent refreshes the
    // row (see the upsert in apps/api/src/railway.ts). Also serves
    // project-scoped lookups via its left-most `project_id` prefix.
    projectUserUniq: uniqueIndex("railway_installations_project_user_idx").on(
      t.projectId,
      t.railwayUserId,
    ),
  }),
);

export type RailwayInstallation = typeof railwayInstallations.$inferSelect;

// A connected Render workspace. Render has no third-party OAuth: the user
// pastes an API key they created in Render's account settings and picks one
// workspace (`ownerId`) to share. One row per (project, Render workspace); a
// re-connect for the same workspace refreshes the row. Like Railway there is
// nothing to provision on Render's side — a worker-side puller reads logs and
// infra metrics from Render's REST API scoped to the chosen workspace and
// forwards them to our intake authenticated by the project ingest key. Render
// API keys don't expire and don't refresh, but they grant access to every
// workspace the creating user belongs to, so the key is encrypted at rest
// (same AES-256-GCM scheme as the other connectors) and only ever used for
// reads within the chosen workspace.
export const renderInstallations = pgTable(
  "render_installations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // The Render workspace ("owner") the user picked at connect — the stable
    // install key alongside the project.
    renderOwnerId: text("render_owner_id").notNull(),
    renderOwnerName: text("render_owner_name"),
    // Snapshot of the workspace's services, refreshed by the puller. Display +
    // pull-planning only, never authorization.
    services:
      jsonb("services").$type<
        Array<{
          id: string;
          name: string;
          type: string;
          region: string | null;
          suspended: boolean;
        }>
      >(),
    // The user's Render API key, encrypted at rest. No expiry, no refresh; the
    // user revokes it from Render's dashboard (which strands the install until
    // reconnect).
    renderApiKeyCiphertext: bytea("render_api_key_ciphertext").notNull(),
    renderApiKeyNonce: bytea("render_api_key_nonce").notNull(),
    renderApiKeyKeyVersion: integer("render_api_key_key_version").notNull().default(1),
    // The ingest key the puller forwards telemetry with, stored encrypted so a
    // re-connect reuses the same key instead of minting a new one.
    apiKeyId: uuid("api_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
    ingestKeyCiphertext: bytea("ingest_key_ciphertext"),
    ingestKeyNonce: bytea("ingest_key_nonce"),
    ingestKeyKeyVersion: integer("ingest_key_key_version"),
    // Puller checkpoint: log pull group (region) → the RFC3339 timestamp of
    // the last forwarded log line plus the ids of the lines at that timestamp
    // (equal-timestamp lines at a page boundary are re-read and deduped by
    // id), so restarts resume without gaps or duplicates. Plain-string values
    // are the earlier timestamp-only shape, still accepted on read.
    logCursor: jsonb("log_cursor").$type<Record<string, { ts: string; ids: string[] } | string>>(),
    // Puller checkpoint for metrics: series identity (resource + kind +
    // distinguishing labels) → epoch seconds of the last forwarded sample.
    metricsCursor: jsonb("metrics_cursor").$type<Record<string, number>>(),
    // Push-stream provisioning state, one per signal. A Render workspace has
    // exactly ONE log stream and ONE metrics stream destination, so connect
    // provisions them to our intake only when the slot is free (or already
    // ours): "provisioned" = Render pushes this signal and the puller skips
    // it; "conflict" = a foreign destination occupies the slot (we never
    // steal it — polling fallback); "unavailable" = plan-gated or rejected
    // (polling fallback). Null = pre-streams install (polling).
    logStream: jsonb("log_stream_state").$type<{
      status: "provisioned" | "conflict" | "unavailable";
      endpoint: string | null;
      detail: string | null;
    }>(),
    metricsStream: jsonb("metrics_stream_state").$type<{
      status: "provisioned" | "conflict" | "unavailable";
      endpoint: string | null;
      detail: string | null;
    }>(),
    installedByUserId: uuid("installed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // One live install per (project, Render workspace); a re-connect refreshes
    // the row (see the upsert in apps/api/src/render.ts). Also serves
    // project-scoped lookups via its left-most `project_id` prefix.
    projectOwnerUniq: uniqueIndex("render_installations_project_owner_idx").on(
      t.projectId,
      t.renderOwnerId,
    ),
  }),
);

export type RenderInstallation = typeof renderInstallations.$inferSelect;

// Per-project ingest source filters. A row means the given (source, signal) is
// DISABLED for the project — the proxy ack-drops that telemetry at the edge.
// Sparse by design: no row = enabled, so a new project ingests everything.
//   source: "otlp" (SDK/OTLP exporters) | "aws" (CloudWatch → Firehose) |
//           "vercel" (Vercel Drains) | "railway" (Railway API puller) |
//           "render" (Render API puller)
//   signal: "traces" | "logs" | "metrics"
export const projectIngestFilters = pgTable(
  "project_ingest_filters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    source: text("source")
      .$type<"otlp" | "aws" | "gcp" | "vercel" | "railway" | "render">()
      .notNull(),
    signal: text("signal").$type<"traces" | "logs" | "metrics">().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    projectSourceSignalUniq: uniqueIndex("project_ingest_filters_project_source_signal_idx").on(
      t.projectId,
      t.source,
      t.signal,
    ),
  }),
);

export type ProjectIngestFilter = typeof projectIngestFilters.$inferSelect;

// The generated service map for a project. One row per project. `graph` is the
// deterministic topology (AWS inventory + observed telemetry edges); `enrichment`
// is the LLM's reviewable grouping/relabel/suggested-links pass on top. The whole
// map is regenerated wholesale by a worker job, so it's stored as JSON blobs
// rather than normalized node/edge tables. `refreshRequestedAt > generatedAt`
// (or a null graph) is the worker's "(re)build me" signal.
export const projectTopologies = pgTable(
  "project_topologies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // Deterministic Topology { nodes, edges, groups } from @superlog/topology.
    graph: jsonb("graph"),
    // TopologyEnrichment { groups, nodePatches, suggestedEdges } from the LLM pass.
    enrichment: jsonb("enrichment"),
    status: text("status").$type<"idle" | "generating" | "error">().default("idle").notNull(),
    error: text("error"),
    generatedAt: timestamp("generated_at", { withTimezone: true }),
    refreshRequestedAt: timestamp("refresh_requested_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    projectUniq: uniqueIndex("project_topologies_project_idx").on(t.projectId),
  }),
);

export type ProjectTopology = typeof projectTopologies.$inferSelect;
export type Org = typeof orgs.$inferSelect;
export type User = typeof users.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type ProjectMcpServerRow = typeof projectMcpServers.$inferSelect;
export type ProjectMcpOauthAttemptRow = typeof projectMcpOauthAttempts.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type OrgApiKey = typeof orgApiKeys.$inferSelect;
export type Issue = typeof issues.$inferSelect;
export type Incident = typeof incidents.$inferSelect;
export type IncidentIssue = typeof incidentIssues.$inferSelect;
export type IncidentResolutionProposal = typeof incidentResolutionProposals.$inferSelect;
export type ProjectAutomationSetting = typeof projectAutomationSettings.$inferSelect;
export type AgentRun = typeof agentRuns.$inferSelect;
export type AgentChat = typeof agentChats.$inferSelect;
export type AgentChatMessage = typeof agentChatMessages.$inferSelect;
export type IncidentEvent = typeof incidentEvents.$inferSelect;
export type CliSession = typeof cliSessions.$inferSelect;
export type McpOauthClient = typeof mcpOauthClients.$inferSelect;
export type McpOauthCode = typeof mcpOauthCodes.$inferSelect;
export type McpOauthToken = typeof mcpOauthTokens.$inferSelect;
export type PersonalAccessToken = typeof personalAccessTokens.$inferSelect;
export type SlackInstallation = typeof slackInstallations.$inferSelect;
export type SavedView = typeof savedViews.$inferSelect;
export type Dashboard = typeof dashboards.$inferSelect;
export type DashboardWidget = typeof dashboardWidgets.$inferSelect;
export type GithubInstallation = typeof githubInstallations.$inferSelect;
export type PrObservabilityReview = typeof prObservabilityReviews.$inferSelect;
export type ProjectGithubRepo = typeof projectGithubRepos.$inferSelect;
export type LinearInstallation = typeof linearInstallations.$inferSelect;
export type LinearAgentSession = typeof linearAgentSessions.$inferSelect;
export type NotionInstallation = typeof notionInstallations.$inferSelect;
export type OrgAgentSettings = typeof orgAgentSettings.$inferSelect;
export type AgentMemory = typeof agentMemories.$inferSelect;
export type NewAgentMemory = typeof agentMemories.$inferInsert;
export type OrgIntegration = typeof orgIntegrations.$inferSelect;
export type OrgIntegrationSecret = typeof orgIntegrationSecrets.$inferSelect;
export type SourceMapArtifact = typeof sourceMapArtifacts.$inferSelect;
export type Alert = typeof alerts.$inferSelect;
export type AlertFiring = typeof alertFirings.$inferSelect;
export type AlertEpisode = typeof alertEpisodes.$inferSelect;
export type AgentPullRequest = typeof agentPullRequests.$inferSelect;
export type AgentPrEvent = typeof agentPrEvents.$inferSelect;
export type AgentLinearTicket = typeof agentLinearTickets.$inferSelect;
export type AgentLinearTicketEvent = typeof agentLinearTicketEvents.$inferSelect;
export type WebhookEndpoint = typeof webhookEndpoints.$inferSelect;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type Feedback = typeof feedback.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Account = typeof accounts.$inferSelect;
export type Verification = typeof verifications.$inferSelect;
export type Invitation = typeof invitations.$inferSelect;
export type OrgMember = typeof orgMembers.$inferSelect;
export type CloudConnection = typeof cloudConnections.$inferSelect;
export type CloudResource = typeof cloudResources.$inferSelect;
