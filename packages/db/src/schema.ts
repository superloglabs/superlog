import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

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
  logAttrs?: Record<string, string> | null;
  resourceAttrs?: Record<string, string> | null;
};

export type GithubRepoAccess = {
  disabledRepoIds?: number[];
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
export type IncidentStatus = "open" | "resolved" | "autoresolved_noise" | "merged";

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

// Who or what flipped an incident to `status='resolved'`. Distinct from
// `noiseReason`, which lives in its own column for the `autoresolved_noise`
// status path.
export type IncidentResolvedByKind =
  | "agent_pr_merged" // our agent opened a PR, GitHub said it merged
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

export type AgentRunResult = {
  state: "complete" | "awaiting_human" | "failed";
  summary: string;
  question?: string | null;
  failureReason?: AgentRunFailureReason | null;
  pr?: AgentRunPr | null;
  linearTicket?: AgentRunLinearTicket | null;
  rootCauseConfidence?: "high" | "medium" | "low" | null;
  // Concise human-readable replacement for incident.title — applied by the worker if present.
  proposedTitle?: string | null;
  rootCause?: AgentRunConfidence | null;
  estimatedImpact?: AgentRunConfidence | null;
  severity?: IncidentSeverity | null;
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
  githubSetupSkippedAt: timestamp("github_setup_skipped_at", { withTimezone: true }),
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
  activeProjectId: uuid("active_project_id").references(() => projects.id, {
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
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
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
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uniq: uniqueIndex("projects_org_slug_idx").on(t.orgId, t.slug),
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

// Org-scoped management API keys. Used by customer backends (e.g. Nanocorp)
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
  claimedByUserId: uuid("claimed_by_user_id").references(() => users.id, { onDelete: "set null" }),
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
    silencedAt: timestamp("silenced_at", { withTimezone: true }),
    lastAlertedAt: timestamp("last_alerted_at", { withTimezone: true }),
    slackMessageTs: text("slack_message_ts"),
    eventCount: bigint("event_count", { mode: "number" }).notNull().default(0),
    groupingState: text("grouping_state").notNull().default("grouped"),
    groupingSource: text("grouping_source"),
    groupingReason: text("grouping_reason"),
    groupingAttemptedAt: timestamp("grouping_attempted_at", { withTimezone: true }),
    groupingAttemptCount: integer("grouping_attempt_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uniq: uniqueIndex("issues_project_fingerprint_idx")
      .on(t.projectId, t.fingerprint)
      .where(sql`silenced_at IS NULL`),
    groupingStateIdx: index("issues_grouping_state_idx")
      .on(t.projectId, t.groupingState)
      .where(sql`grouping_state IN ('pending', 'failed')`),
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
    lastSlackPostedAt: timestamp("last_slack_posted_at", { withTimezone: true }),
    // Suppress auto-investigation until this time. Set when an agent run
    // resolves an incident as `fixed_in_current_code`, since prod recurrence
    // before the deploy promotes is expected and shouldn't re-trigger the agent.
    // Manual restarts ignore this field.
    autoInvestigateSuppressedUntil: timestamp("auto_investigate_suppressed_until", {
      withTimezone: true,
    }),
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
    incidentIssueUniq: uniqueIndex("incident_issues_issue_idx").on(t.issueId),
    incidentLookupIdx: index("incident_issues_incident_idx").on(t.incidentId),
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
    agentRunProvider: text("agent_run_provider").notNull().default("anthropic"),
    maxRuntimeMinutes: integer("max_runtime_minutes").notNull().default(90),
    maxHumanResumeCount: integer("max_human_resume_count").notNull().default(3),
    customInstructions: text("custom_instructions").notNull().default(""),
    agentRunEnabled: boolean("agent_run_enabled").notNull().default(true),
    linearTicketPolicy: text("linear_ticket_policy")
      .$type<"never" | "on_ready_to_pr" | "always">()
      .notNull()
      .default("on_ready_to_pr"),
    linearTicketInstructions: jsonb("linear_ticket_instructions")
      .$type<LinearTicketInstruction[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    prPolicy: text("pr_policy")
      .$type<"never" | "on_ready_to_pr" | "always">()
      .notNull()
      .default("on_ready_to_pr"),
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
    runtime: text("runtime").notNull().default("anthropic"),
    state: text("state").notNull().default("queued"),
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
    lastSlackPostedAt: timestamp("last_slack_posted_at", { withTimezone: true }),
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

export type WebhookEventType = "agent_run.completed";

export const WEBHOOK_EVENT_TYPES: readonly WebhookEventType[] = ["agent_run.completed"] as const;

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
      .default(sql`'["agent_run.completed"]'::jsonb`),
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
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

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
    accessExpiresAt: timestamp("access_expires_at", { withTimezone: true }).notNull(),
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
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    installationId: bigint("installation_id", { mode: "number" }).notNull(),
    accountLogin: text("account_login"),
    accountType: text("account_type"),
    repos: jsonb("repos").$type<{ id: number; fullName: string; private: boolean }[]>(),
    agentEnabled: boolean("agent_enabled").default(true).notNull(),
    repoAccess: jsonb("repo_access").$type<GithubRepoAccess>(),
    commitAuthorName: text("commit_author_name"),
    commitAuthorEmail: text("commit_author_email"),
    commitAuthorGithubLogin: text("commit_author_github_login"),
    commitAuthorGithubId: bigint("commit_author_github_id", { mode: "number" }),
    commitAuthorAvatarUrl: text("commit_author_avatar_url"),
    commitAuthorSetByUserId: uuid("commit_author_set_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    commitAuthorSetAt: timestamp("commit_author_set_at", { withTimezone: true }),
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
  },
  (t) => ({
    projectTeamUniq: uniqueIndex("slack_installations_project_team_idx").on(t.projectId, t.teamId),
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
    resourceAttrs?: { key: string; value: string; op?: "eq" | "neq" | "not_contains" }[];
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

export const dashboards = pgTable(
  "dashboards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
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
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorEmail: text("actor_email"),
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
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgUniq: uniqueIndex("org_agent_settings_org_idx").on(t.orgId),
  }),
);

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

const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});

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
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
  },
  (t) => ({
    alertGroupIdx: index("alert_firings_alert_group_idx").on(t.alertId, t.groupKey, t.evaluatedAt),
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
export type FeedbackSource = "dialog" | "slack_button" | "pr_comment" | "pr_link";
export type FeedbackStatus = "new" | "triaged" | "closed";
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
    body: text("body").notNull(),
    authorUserId: uuid("author_user_id").references(() => users.id, { onDelete: "set null" }),
    authorExternal: jsonb("author_external").$type<FeedbackAuthorExternal>(),
    orgId: uuid("org_id").references(() => orgs.id, { onDelete: "set null" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
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
  }),
);

export type Org = typeof orgs.$inferSelect;
export type User = typeof users.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type OrgApiKey = typeof orgApiKeys.$inferSelect;
export type Issue = typeof issues.$inferSelect;
export type Incident = typeof incidents.$inferSelect;
export type IncidentIssue = typeof incidentIssues.$inferSelect;
export type IncidentResolutionProposal = typeof incidentResolutionProposals.$inferSelect;
export type ProjectAutomationSetting = typeof projectAutomationSettings.$inferSelect;
export type AgentRun = typeof agentRuns.$inferSelect;
export type IncidentEvent = typeof incidentEvents.$inferSelect;
export type CliSession = typeof cliSessions.$inferSelect;
export type McpOauthClient = typeof mcpOauthClients.$inferSelect;
export type McpOauthCode = typeof mcpOauthCodes.$inferSelect;
export type McpOauthToken = typeof mcpOauthTokens.$inferSelect;
export type SlackInstallation = typeof slackInstallations.$inferSelect;
export type Dashboard = typeof dashboards.$inferSelect;
export type DashboardWidget = typeof dashboardWidgets.$inferSelect;
export type GithubInstallation = typeof githubInstallations.$inferSelect;
export type ProjectGithubRepo = typeof projectGithubRepos.$inferSelect;
export type LinearInstallation = typeof linearInstallations.$inferSelect;
export type OrgAgentSettings = typeof orgAgentSettings.$inferSelect;
export type OrgIntegration = typeof orgIntegrations.$inferSelect;
export type OrgIntegrationSecret = typeof orgIntegrationSecrets.$inferSelect;
export type Alert = typeof alerts.$inferSelect;
export type AlertFiring = typeof alertFirings.$inferSelect;
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
