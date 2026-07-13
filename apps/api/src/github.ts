import crypto from "node:crypto";
import {
  db,
  decideInboundContinuation,
  listAccessibleGithubInstallsForProject,
  recordInboundInteraction,
  resolveIncident,
  schema,
  syncLoopsContactsForOrg,
} from "@superlog/db";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Hono } from "hono";
import type { Context } from "hono";
import {
  FEEDBACK_PR_FOOTER_MARKER,
  isFeedbackEligibleCommenter,
  recordFeedback,
} from "./feedback.js";
import { getDeviceFlow, getLinkedDevice, getSkillDeviceForIntegration } from "./gateway.js";
import { type RepoBranch, type RepoBranchInfo, mergeRepoBranches } from "./github-branches.js";
import { runResolvedIncidentSideEffectsForIncident } from "./incidents/resolution-side-effects.js";
import { logger } from "./logger.js";
import { resolveActiveOrgContext } from "./org-context.js";
import { prTerminalTransition } from "./pr-metrics-transition.js";
import { recordPrClosedMetric, recordPrMergedMetric } from "./pr-metrics.js";

const log = logger.child({ scope: "github" });
type Vars = { userId: string; orgId: string | null };
const DEFAULT_COMMIT_AUTHOR = {
  name: "Superlog app",
  email: "bot@superlog.sh",
};

// biome-ignore lint/suspicious/noExplicitAny: Hono Variables invariance.
export function mountGithubPublic(app: Hono<any>): void {
  const appSlug = process.env.GITHUB_APP_SLUG;
  const stateSecret = process.env.STATE_SIGNING_SECRET;
  const webhookSecret = process.env.GITHUB_APP_WEBHOOK_SECRET;
  const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:5173";
  const oauthClientId =
    process.env.GITHUB_OAUTH_CLIENT_ID ??
    process.env.GITHUB_APP_CLIENT_ID ??
    process.env.GITHUB_CLIENT_ID;
  const oauthClientSecret =
    process.env.GITHUB_OAUTH_CLIENT_SECRET ??
    process.env.GITHUB_APP_CLIENT_SECRET ??
    process.env.GITHUB_CLIENT_SECRET;
  const installRedirectUrl =
    process.env.GITHUB_INSTALL_OAUTH_REDIRECT_URL ??
    "http://localhost:4100/github/install/callback";

  if (!appSlug) {
    log.warn("GITHUB_APP_SLUG not set — /github/install disabled");
  }
  if (!stateSecret) {
    log.warn("STATE_SIGNING_SECRET not set — /github/install disabled");
  }
  if (!webhookSecret) {
    log.warn("GITHUB_APP_WEBHOOK_SECRET not set — /github/webhook disabled");
  }

  app.get("/github/install", (c) => {
    if (!appSlug || !stateSecret) {
      return c.json({ error: "github app not configured" }, 503);
    }
    const userCode = (c.req.query("user_code") ?? "").toUpperCase();
    // CLI/MCP flow: device must be in user_linked state. Skill flow drives
    // GitHub install AFTER pairing (device already approved), so fall back
    // to the skill-device helper when getLinkedDevice rejects it.
    const device = getLinkedDevice(userCode) ?? getSkillDeviceForIntegration(userCode);
    if (!device) return c.json({ error: "unknown or not-ready device code" }, 404);

    const state = signState("cli", userCode, stateSecret);
    const url = new URL(`https://github.com/apps/${appSlug}/installations/new`);
    url.searchParams.set("state", state);
    return c.redirect(url.toString(), 302);
  });

  app.get("/github/install/callback", async (c) => {
    if (!stateSecret) return c.json({ error: "github app not configured" }, 503);
    const installationIdRaw = c.req.query("installation_id");
    const state = c.req.query("state") ?? "";
    const setupAction = c.req.query("setup_action") ?? "install";
    const oauthCode = c.req.query("code") ?? null;
    log.info(
      {
        setup_action: setupAction,
        installation_id: installationIdRaw ?? null,
        has_oauth_code: !!oauthCode,
      },
      "github install callback received",
    );

    const installationId = Number(installationIdRaw);
    const marker = setupAction === "update" ? "updated" : "done";

    // First try the management-API state shape for platform provisioning.
    // Falls through to the existing cli/web state shape if not a mgmt state.
    const mgmt = verifyMgmtState(state, stateSecret);
    if (mgmt) {
      const callbackWebOrigin = resolveCallbackWebOrigin(c, webOrigin);
      const failTarget = mgmt.returnUrl ?? `${callbackWebOrigin}/`;
      if (!Number.isFinite(installationId) || installationId <= 0) {
        return c.redirect(`${failTarget}${failTarget.includes("?") ? "&" : "?"}gh=error`, 302);
      }
      let resolvedOrgId: string;
      let resolvedProjectId: string | null;
      if (mgmt.scope === "org") {
        resolvedOrgId = mgmt.orgId;
        resolvedProjectId = null;
      } else {
        const project = await db.query.projects.findFirst({
          where: eq(schema.projects.id, mgmt.projectId),
        });
        if (!project) {
          return c.redirect(`${failTarget}${failTarget.includes("?") ? "&" : "?"}gh=error`, 302);
        }
        resolvedOrgId = project.orgId;
        resolvedProjectId = project.id;
      }
      const rowId = await upsertInstallation({
        orgId: resolvedOrgId,
        projectId: resolvedProjectId,
        installationId,
      });
      await resumeBlockedAgentRunsForOrg(resolvedOrgId, "github_install", {
        projectIdHint: resolvedProjectId,
      });
      await maybeCaptureInstallerIdentity({
        installationRowId: rowId,
        installationId,
        oauthCode,
        clientId: oauthClientId,
        clientSecret: oauthClientSecret,
        redirectUrl: installRedirectUrl,
      });
      const successTarget = mgmt.returnUrl ?? `${callbackWebOrigin}/`;
      return c.redirect(
        `${successTarget}${successTarget.includes("?") ? "&" : "?"}gh=${marker}`,
        302,
      );
    }

    const decoded = verifyState(state, stateSecret);
    if (!decoded) return c.json({ error: "invalid state" }, 400);

    // "cli" kind: value is userCode → resolve org+project from device.
    // "web" kind: value is projectId → resolve org from the project row.
    let orgId: string | null;
    let projectId: string | null;
    if (decoded.kind === "cli") {
      const device = getLinkedDevice(decoded.value) ?? getSkillDeviceForIntegration(decoded.value);
      orgId = device?.orgId ?? null;
      projectId = device?.projectId ?? null;
    } else {
      const project = await db.query.projects.findFirst({
        where: eq(schema.projects.id, decoded.value),
      });
      orgId = project?.orgId ?? null;
      projectId = project?.id ?? null;
    }

    if (decoded.kind === "cli") {
      const userCode = decoded.value;
      const flow = getDeviceFlow(userCode);
      const flowQuery = flow === "skill" ? "&flow=skill" : "";
      const callbackWebOrigin = resolveCallbackWebOrigin(c, webOrigin);
      if (!orgId || !projectId) {
        return c.redirect(
          `${callbackWebOrigin}/activate?code=${userCode}${flowQuery}&gh=expired`,
          302,
        );
      }
      if (!Number.isFinite(installationId) || installationId <= 0) {
        return c.redirect(
          `${callbackWebOrigin}/activate?code=${userCode}${flowQuery}&gh=error`,
          302,
        );
      }
      const rowId = await upsertInstallation({ orgId, projectId, installationId });
      await resumeBlockedAgentRunsForProjects([projectId], "github_install");
      await maybeCaptureInstallerIdentity({
        installationRowId: rowId,
        installationId,
        oauthCode,
        clientId: oauthClientId,
        clientSecret: oauthClientSecret,
        redirectUrl: installRedirectUrl,
      });
      return c.redirect(
        `${callbackWebOrigin}/activate?code=${userCode}${flowQuery}&gh=${marker}`,
        302,
      );
    }

    // decoded.kind === "web" — value resolved to project above.
    const callbackWebOrigin = resolveCallbackWebOrigin(c, webOrigin);
    if (!Number.isFinite(installationId) || installationId <= 0 || !orgId || !projectId) {
      return c.redirect(`${callbackWebOrigin}/?gh=error`, 302);
    }
    const rowId = await upsertInstallation({ orgId, projectId, installationId });
    await resumeBlockedAgentRunsForProjects([projectId], "github_install");
    await maybeCaptureInstallerIdentity({
      installationRowId: rowId,
      installationId,
      oauthCode,
      clientId: oauthClientId,
      clientSecret: oauthClientSecret,
      redirectUrl: installRedirectUrl,
    });
    return c.redirect(`${callbackWebOrigin}/?gh=${marker}`, 302);
  });

  app.post("/github/webhook", async (c) => {
    if (!webhookSecret) return c.json({ error: "webhook not configured" }, 503);

    const rawBody = await c.req.text();
    const sigHeader = c.req.header("x-hub-signature-256") ?? "";
    if (!verifyWebhookSignature(rawBody, sigHeader, webhookSecret)) {
      log.warn({ delivery: c.req.header("x-github-delivery") }, "github webhook signature failed");
      return c.json({ error: "bad signature" }, 401);
    }

    const event = c.req.header("x-github-event") ?? "";
    let payload: WebhookPayload;
    try {
      payload = JSON.parse(rawBody) as WebhookPayload;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const delivery = c.req.header("x-github-delivery") ?? null;
    try {
      await handleWebhook(event, payload, delivery);
      log.info(
        {
          event,
          action: payload.action,
          installation_id: payload.installation?.id,
          delivery,
        },
        "github webhook handled",
      );
    } catch (err) {
      log.error(
        {
          err,
          event,
          action: payload.action,
          installation_id: payload.installation?.id,
        },
        "webhook handler failed",
      );
      // Let GitHub retry on transient failures.
      return c.json({ error: "handler failed" }, 500);
    }
    return c.json({ ok: true });
  });
}

function resolveCallbackWebOrigin(c: Context, configuredWebOrigin: string): string {
  const host = c.req.header("host") ?? "";
  if (
    host === "localhost:4100" ||
    host === "127.0.0.1:4100" ||
    configuredWebOrigin.endsWith(".superlog.localhost:1355")
  ) {
    return "http://localhost:5173";
  }
  return configuredWebOrigin;
}

type GhRepo = { id: number; full_name: string; private: boolean };
export type StoredRepo = { id: number; fullName: string; private: boolean };
type RepoAccess = { disabledRepoIds?: number[] };
type GithubRepoSummary = StoredRepo & { enabled: boolean };
type GithubInstallationReposResponse = { repositories: GhRepo[] };
type GithubOAuthTokenResponse = {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
};
type GithubViewerResponse = {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
};
type GithubEmailResponse = {
  email: string;
  primary: boolean;
  verified: boolean;
  visibility: string | null;
};
type GithubUserInstallation = {
  id: number;
  account: { login?: string; type?: string } | null;
  html_url: string;
  repository_selection: "all" | "selected";
  suspended_at: string | null;
};
type GithubUserInstallationsResponse = {
  installations: GithubUserInstallation[];
};
type GithubUserInstallationReposResponse = {
  repositories: Array<{ id: number; full_name: string; private: boolean }>;
};
type GithubInstallationSummary = {
  installationId: number;
  accountLogin: string | null;
  accountType: string | null;
  enabled: boolean;
  manageUrl: string;
  repos: GithubRepoSummary[];
};
type CommitAuthor = {
  name: string;
  email: string;
  githubLogin: string;
  githubId: number;
  avatarUrl: string | null;
};
type GhActor = {
  login?: string;
  id?: number;
  avatar_url?: string | null;
  type?: string;
} | null;
type WebhookPayload = {
  action?: string;
  installation?: {
    id: number;
    account?: { login?: string; type?: string };
  };
  repositories?: GhRepo[];
  repositories_added?: GhRepo[];
  repositories_removed?: GhRepo[];
  // pull_request events / pull_request_review / pull_request_review_comment
  repository?: { full_name?: string };
  pull_request?: {
    number?: number;
    node_id?: string;
    state?: string;
    title?: string;
    merged?: boolean;
    merged_at?: string | null;
    closed_at?: string | null;
    merged_by?: GhActor;
    user?: GhActor;
    head?: { sha?: string; ref?: string };
    base?: { ref?: string };
    html_url?: string;
  };
  // issue_comment (only PR if issue.pull_request present)
  issue?: {
    number?: number;
    pull_request?: { url?: string };
  };
  comment?: {
    id?: number;
    body?: string;
    user?: GhActor;
    html_url?: string;
    author_association?: string;
    // pull_request_review_comment only
    path?: string;
    line?: number | null;
  };
  review?: {
    id?: number;
    state?: string;
    body?: string | null;
    user?: GhActor;
    html_url?: string;
    author_association?: string;
  };
  // push events
  ref?: string;
  after?: string;
  before?: string;
  pusher?: { name?: string; email?: string };
  sender?: GhActor;
  commits?: Array<{ id?: string; message?: string; author?: { name?: string; email?: string } }>;
};

async function handleWebhook(
  event: string,
  payload: WebhookPayload,
  delivery: string | null,
): Promise<void> {
  if (
    event === "pull_request" ||
    event === "pull_request_review" ||
    event === "pull_request_review_comment" ||
    event === "issue_comment" ||
    event === "push"
  ) {
    await handleAgentPrWebhook(event, payload, delivery);
    return;
  }

  const installationId = payload.installation?.id;
  if (!installationId) return;

  if (event === "installation") {
    const action = payload.action;
    if (action === "created" || action === "new_permissions_accepted") {
      await db
        .update(schema.githubInstallations)
        .set({
          accountLogin: payload.installation?.account?.login ?? null,
          accountType: payload.installation?.account?.type ?? null,
          repos: [],
          revokedAt: null,
        })
        .where(eq(schema.githubInstallations.installationId, installationId));
      await resumeBlockedAgentRunsForInstallation(installationId, "github_install");
      return;
    }
    if (action === "deleted" || action === "suspend") {
      await db
        .update(schema.githubInstallations)
        .set({ revokedAt: new Date() })
        .where(eq(schema.githubInstallations.installationId, installationId));
      return;
    }
    if (action === "unsuspend") {
      await db
        .update(schema.githubInstallations)
        .set({ revokedAt: null })
        .where(eq(schema.githubInstallations.installationId, installationId));
      await resumeBlockedAgentRunsForInstallation(installationId, "github_install");
      return;
    }
    return;
  }

  if (event === "installation_repositories") {
    const row = await db.query.githubInstallations.findFirst({
      where: eq(schema.githubInstallations.installationId, installationId),
    });
    if (!row) return;
    await db
      .update(schema.githubInstallations)
      .set({
        repos: [],
        accountLogin: payload.installation?.account?.login ?? row.accountLogin,
        accountType: payload.installation?.account?.type ?? row.accountType,
      })
      .where(eq(schema.githubInstallations.installationId, installationId));
    if (payload.action === "added") {
      await resumeBlockedAgentRunsForInstallation(installationId, "github_repos_added");
    }
  }
}

// Requeue any agentRuns sitting in `blocked_no_github` under the given
// project(s). Cheap and idempotent — single bulk UPDATE + batched event
// inserts. Callers: install webhook (resolves project IDs from
// installationId) and the OAuth install callback (knows projectId directly,
// avoids a webhook/callback race on first-time installs where the github
// installations row may not exist yet when the webhook arrives).
export async function resumeBlockedAgentRunsForProjects(
  projectIds: string[],
  trigger: "github_install" | "github_repos_added",
): Promise<void> {
  if (projectIds.length === 0) return;
  const blocked = await db
    .select({ id: schema.agentRuns.id })
    .from(schema.agentRuns)
    .innerJoin(schema.incidents, eq(schema.incidents.id, schema.agentRuns.incidentId))
    .where(
      and(
        eq(schema.agentRuns.state, "blocked_no_github"),
        inArray(schema.incidents.projectId, projectIds),
      ),
    );
  if (blocked.length === 0) return;

  const ids = blocked.map((row) => row.id);
  const now = new Date();
  await db
    .update(schema.agentRuns)
    .set({ state: "queued", updatedAt: now })
    .where(inArray(schema.agentRuns.id, ids));
  await db
    .insert(schema.incidentEvents)
    .values(
      ids.map((id) => ({
        agentRunId: id,
        kind: "unblocked",
        summary: "Investigation requeued.",
        detail: { trigger },
        dedupeKey: `unblocked:${id}:${now.getTime()}`,
        processedAt: now,
      })),
    )
    .onConflictDoNothing();
  log.info({ projectIds, trigger, count: ids.length }, "resumed blocked agent_runs");
}

// Org-scoped resume — fans out across every project in the org. Used for
// org-scoped installs where the install grants access to repos that any
// project can be wired up to. The optional `projectIdHint` is purely an
// optimisation: if the caller already knows one project should be revived,
// it's bundled into the same single query so we still issue one bulk update.
async function resumeBlockedAgentRunsForOrg(
  orgId: string,
  trigger: "github_install" | "github_repos_added",
  opts: { projectIdHint?: string | null } = {},
): Promise<void> {
  const orgProjects = await db.query.projects.findMany({
    where: eq(schema.projects.orgId, orgId),
    columns: { id: true },
  });
  const projectIds = new Set(orgProjects.map((row) => row.id));
  if (opts.projectIdHint) projectIds.add(opts.projectIdHint);
  if (projectIds.size === 0) return;
  await resumeBlockedAgentRunsForProjects([...projectIds], trigger);
}

async function resumeBlockedAgentRunsForInstallation(
  installationId: number,
  trigger: "github_install" | "github_repos_added",
): Promise<void> {
  const installs = await db.query.githubInstallations.findMany({
    where: and(
      eq(schema.githubInstallations.installationId, installationId),
      isNull(schema.githubInstallations.revokedAt),
    ),
    columns: { orgId: true, projectId: true },
  });
  if (installs.length === 0) return;
  // Project-scoped installs grant access narrowly — fan out to that project
  // only. Org-scoped installs (projectId null) can grant repos to any project
  // in the org, so widen to every project under the org.
  const directProjectIds = installs
    .map((row) => row.projectId)
    .filter((id): id is string => id !== null);
  if (directProjectIds.length > 0) {
    await resumeBlockedAgentRunsForProjects(directProjectIds, trigger);
  }
  const orgIdsForOrgScoped = Array.from(
    new Set(installs.filter((row) => row.projectId === null).map((row) => row.orgId)),
  );
  for (const orgId of orgIdsForOrgScoped) {
    await resumeBlockedAgentRunsForOrg(orgId, trigger);
  }
}

async function handleAgentPrWebhook(
  event: string,
  payload: WebhookPayload,
  delivery: string | null,
): Promise<void> {
  const repoFullName = payload.repository?.full_name;
  if (!repoFullName) return;

  // Resolve which agent_pull_request row this event is about.
  let prNumber: number | undefined;
  if (
    event === "pull_request" ||
    event === "pull_request_review" ||
    event === "pull_request_review_comment"
  ) {
    prNumber = payload.pull_request?.number;
  } else if (event === "issue_comment") {
    if (!payload.issue?.pull_request) return;
    prNumber = payload.issue.number;
  }
  // push: resolve by branch
  let agentPrRow: schema.AgentPullRequest | undefined;
  if (event === "push") {
    const ref = payload.ref;
    if (!ref?.startsWith("refs/heads/")) return;
    const branch = ref.slice("refs/heads/".length);
    agentPrRow = await db.query.agentPullRequests.findFirst({
      where: and(
        eq(schema.agentPullRequests.repoFullName, repoFullName),
        eq(schema.agentPullRequests.branchName, branch),
      ),
    });
  } else if (typeof prNumber === "number") {
    agentPrRow = await db.query.agentPullRequests.findFirst({
      where: and(
        eq(schema.agentPullRequests.repoFullName, repoFullName),
        eq(schema.agentPullRequests.prNumber, prNumber),
      ),
    });
  }
  if (!agentPrRow) return;

  // Capture human review comments as feedback. We surface this in
  // /admin/feedback so we can hear about how our agent-opened PRs are
  // landing with the people reviewing them. Bot comments (greptile and
  // friends) and the GitHub "review submitted" envelope (which has its
  // own dedicated state machine in describeAgentPrEvent) are skipped.
  //
  // Best-effort: don't let a feedback DB error cascade into a 500 that
  // makes GitHub retry the whole delivery. A retry would re-run the
  // agent_pr_events insert (idempotent via onConflictDoNothing) and the
  // PR state update, but a partial state where the feedback row landed
  // before the retry-triggering throw is exactly the kind of "I see the
  // feedback but not the merge-resolved incident" inconsistency we want
  // to avoid. Matches the wrapping pattern used for Slack feedback in
  // apps/api/src/slack.ts.
  await maybeRecordPrCommentFeedback({ event, payload, agentPrRow }).catch((err) => {
    log.warn({ err, event, agent_pr_id: agentPrRow.id }, "pr comment feedback capture failed");
  });

  // Same best-effort posture: a follow-up enqueue failure must not 500 the
  // webhook delivery.
  await maybeRequestPrCommentFollowUp({ event, payload, agentPrRow }).catch((err) => {
    log.warn({ err, event, agent_pr_id: agentPrRow.id }, "pr comment follow-up enqueue failed");
  });

  const now = new Date();

  // Update the parent row when this is a state-changing event.
  if (event === "pull_request") {
    const action = payload.action ?? "";
    const pr = payload.pull_request ?? {};
    let mergedResolution: { mergedAt: Date; mergedByLogin: string | null } | null = null;
    const updates: Partial<typeof schema.agentPullRequests.$inferInsert> = {
      lastSyncedAt: now,
      updatedAt: now,
    };
    if (pr.head?.sha) updates.headSha = pr.head.sha;
    if (typeof pr.title === "string") updates.title = pr.title;
    // Decide whether this delivery looks like a brand-new terminal transition
    // from the row we read. This is only a first cut — the read is stale under
    // concurrent deliveries, so the actual once-only guarantee comes from the
    // conditional UPDATE below, not from this check.
    const countTransition = prTerminalTransition({
      action,
      merged: Boolean(pr.merged),
      prevState: agentPrRow.state,
    });
    if (action === "closed") {
      if (pr.merged) {
        updates.state = "merged";
        if (pr.merged_at) updates.mergedAt = new Date(pr.merged_at);
        updates.closedAt = pr.closed_at ? new Date(pr.closed_at) : now;
        updates.mergedByLogin = pr.merged_by?.login ?? null;
        updates.mergedByGithubId = pr.merged_by?.id ?? null;
        mergedResolution = {
          mergedAt: updates.mergedAt ?? updates.closedAt ?? now,
          mergedByLogin: updates.mergedByLogin ?? null,
        };
      } else {
        updates.state = "closed";
        updates.closedAt = pr.closed_at ? new Date(pr.closed_at) : now;
      }
    } else if (action === "reopened") {
      updates.state = "open";
      updates.closedAt = null;
    }
    // For a terminal transition, fold the prior-state predicate into the WHERE
    // so only one of N concurrent deliveries actually flips the row. `.returning`
    // tells us which one won; the counter is incremented exactly once off that,
    // not off the stale read above. Non-terminal updates (reopened, push-only
    // field writes) stay unconditional.
    const updated = await db
      .update(schema.agentPullRequests)
      .set(updates)
      .where(
        countTransition
          ? and(
              eq(schema.agentPullRequests.id, agentPrRow.id),
              ne(schema.agentPullRequests.state, countTransition),
            )
          : eq(schema.agentPullRequests.id, agentPrRow.id),
      )
      .returning({ id: schema.agentPullRequests.id });
    const wonTransition = updated.length > 0;
    if (countTransition === "merged" && wonTransition) {
      await recordPrMergedMetric({
        agentPr: agentPrRow,
        resolvedAt: updates.mergedAt ?? updates.closedAt ?? now,
        mergedByLogin: updates.mergedByLogin ?? null,
      });
    } else if (countTransition === "closed" && wonTransition) {
      await recordPrClosedMetric({
        agentPr: agentPrRow,
        resolvedAt: updates.closedAt ?? now,
      });
    }
    if (mergedResolution) {
      await resumeOrResolveIncidentForMergedAgentPr({
        agentPr: agentPrRow,
        mergedAt: mergedResolution.mergedAt,
        mergedByLogin: mergedResolution.mergedByLogin,
      });
    } else if (updates.state === "closed" && wonTransition) {
      await maybeResumeIncidentForClosedAgentPr({
        agentPr: agentPrRow,
        closedByLogin: payload.sender?.login ?? null,
        closedAt: updates.closedAt ?? now,
      });
    }
  } else if (event === "push") {
    if (payload.after) {
      await db
        .update(schema.agentPullRequests)
        .set({ headSha: payload.after, lastSyncedAt: now, updatedAt: now })
        .where(eq(schema.agentPullRequests.id, agentPrRow.id));
    }
  }

  const { kind, summary, actor } = describeAgentPrEvent(event, payload);
  if (!kind) return;

  await db
    .insert(schema.agentPrEvents)
    .values({
      agentPrId: agentPrRow.id,
      kind,
      summary,
      actorLogin: actor?.login ?? null,
      actorGithubId: actor?.id ?? null,
      actorAvatarUrl: actor?.avatar_url ?? null,
      payload: payload as unknown as Record<string, unknown>,
      providerEventId: delivery,
      occurredAt: now,
    })
    .onConflictDoNothing();
}

// Route a PR lifecycle event (merge/close) into the incident's durable
// investigation session when one can be resumed: the agent — not the webhook —
// decides whether the incident is done. Returns true when the event reached a
// session (or already had, on redelivery).
async function resumeIncidentSessionForPrEvent(opts: {
  agentPr: schema.AgentPullRequest;
  channel: "pr_merged" | "pr_closed";
  author: string | null;
  text: string;
  dedupeKey: string;
}): Promise<boolean> {
  const incident = await db.query.incidents.findFirst({
    where: eq(schema.incidents.id, opts.agentPr.incidentId),
    columns: { id: true, status: true, projectId: true },
  });
  // Only open incidents have a decision left to make. Also guards the
  // self-inflicted case: resolving an incident closes its remaining open PRs,
  // and those `closed` webhooks must not re-ping the session.
  if (!incident || incident.status !== "open") return false;

  const automation = await db.query.projectAutomationSettings.findFirst({
    where: eq(schema.projectAutomationSettings.projectId, incident.projectId),
    columns: { agentRunEnabled: true, autoFollowUpEnabled: true },
  });
  const latestRun = await db.query.agentRuns.findFirst({
    where: eq(schema.agentRuns.incidentId, incident.id),
    orderBy: [desc(schema.agentRuns.createdAt)],
    columns: { id: true, state: true, providerSessionId: true },
  });
  // Pre-route so a merge/close never cold-starts a fresh investigation: with
  // no resumable session the caller falls back to its deterministic behavior
  // (auto-resolve for merges, nothing for closes).
  const verdict = decideInboundContinuation({
    agentRunEnabled: automation?.agentRunEnabled ?? true,
    autoFollowUpEnabled: automation?.autoFollowUpEnabled ?? true,
    confirmed: true,
    latestRun: latestRun ?? null,
  });
  if (verdict.action !== "resume" && verdict.action !== "steer") return false;

  const result = await recordInboundInteraction(db, {
    incidentId: incident.id,
    interaction: {
      channel: opts.channel,
      author: opts.author,
      text: opts.text,
      url: opts.agentPr.url,
      occurredAt: new Date().toISOString(),
    },
    dedupeKey: opts.dedupeKey,
    confirmed: true,
  });
  if (result.outcome === "duplicate") return true;
  return result.outcome === "accepted" && result.action !== "cold_start";
}

// An agent PR merged. Resume the durable session so the agent decides whether
// the incident is complete (per the spec, the agent is the judge of done);
// when no session can be resumed, fall back to resolving the incident
// directly — an incident must never stay open forever because its session
// expired.
async function resumeOrResolveIncidentForMergedAgentPr(opts: {
  agentPr: schema.AgentPullRequest;
  mergedAt: Date;
  mergedByLogin: string | null;
}): Promise<void> {
  const { agentPr, mergedByLogin } = opts;
  const resumed = await resumeIncidentSessionForPrEvent({
    agentPr,
    channel: "pr_merged",
    author: mergedByLogin,
    text: `Your PR #${agentPr.prNumber} (${agentPr.repoFullName}, branch \`${agentPr.branchName}\`) was merged${
      mergedByLogin ? ` by @${mergedByLogin}` : ""
    }. If this completes the remediation, make sure every linked issue is classified and call resolve_incident; if more work remains (other PRs still open, issues unclassified), continue it.`,
    dedupeKey: `agent_pr_merged:${agentPr.id}`,
  }).catch((err) => {
    log.warn(
      { err, agent_pr_id: agentPr.id, incident_id: agentPr.incidentId },
      "failed to resume session for merged agent PR; falling back to auto-resolve",
    );
    return false;
  });
  if (resumed) return;
  await resolveIncidentForMergedAgentPr(opts);
}

// An agent PR was closed without merging. Resume the session so the agent can
// react (per the spec: if the close context shows the issue is noise, silence
// it and resolve; otherwise decide the next step). No fallback action — the
// incident simply stays open for a human or a later run.
async function maybeResumeIncidentForClosedAgentPr(opts: {
  agentPr: schema.AgentPullRequest;
  closedByLogin: string | null;
  closedAt: Date;
}): Promise<void> {
  const { agentPr, closedByLogin } = opts;
  await resumeIncidentSessionForPrEvent({
    agentPr,
    channel: "pr_closed",
    author: closedByLogin,
    text: `Your PR #${agentPr.prNumber} (${agentPr.repoFullName}, branch \`${agentPr.branchName}\`) was closed without being merged${
      closedByLogin ? ` by @${closedByLogin}` : ""
    }. Read the PR conversation for the close context: if it shows the incident is actually noise, classify the issues accordingly and call resolve_incident; if the fix is still needed, decide the next step (an adjusted PR, or ask_human).`,
    dedupeKey: `agent_pr_closed:${agentPr.id}:${opts.closedAt.getTime()}`,
  }).catch((err) => {
    log.warn(
      { err, agent_pr_id: agentPr.id, incident_id: agentPr.incidentId },
      "failed to resume session for closed agent PR",
    );
    return false;
  });
}

async function resolveIncidentForMergedAgentPr(opts: {
  agentPr: schema.AgentPullRequest;
  mergedAt: Date;
  mergedByLogin: string | null;
}): Promise<void> {
  const { agentPr, mergedAt, mergedByLogin } = opts;
  const { resolved } = await resolveIncident({
    incidentId: agentPr.incidentId,
    kind: "agent_pr_merged",
    reasonCode: "agent_pr_merged",
    reasonText: `Resolved because agent PR #${agentPr.prNumber} (${agentPr.repoFullName}) was merged${
      mergedByLogin ? ` by @${mergedByLogin}` : ""
    }.`,
    agentRunId: agentPr.agentRunId,
    eventSummary: `Incident resolved because PR #${agentPr.prNumber} was merged.`,
    eventDetail: {
      agentPrId: agentPr.id,
      repoFullName: agentPr.repoFullName,
      prNumber: agentPr.prNumber,
      prUrl: agentPr.url,
      mergedByLogin,
    },
    eventDedupeKey: `incident_resolved:agent_pr:${agentPr.id}`,
    resolvedAt: mergedAt,
  });
  if (resolved) {
    await runResolvedIncidentSideEffectsForIncident({
      incidentId: agentPr.incidentId,
      closePullRequest: (pr) =>
        closeAgentPullRequestOnGithub({
          installationId: pr.githubInstallationId,
          fallbackInstallationIds: pr.fallbackGithubInstallationIds,
          repoFullName: pr.repoFullName,
          prNumber: pr.prNumber,
          prNodeId: pr.prNodeId,
        }),
    });
  }
}

type EligiblePrComment = {
  body: string;
  actor: GhActor;
  commentUrl: string | null;
  path: string | null;
  line: number | null;
  // Stable GitHub id of the comment/review — a deterministic dedupe key across
  // webhook redelivery, used in preference to the URL.
  sourceId: string | null;
};

// Shared gate for the comment-bearing PR events: real text from a real
// (non-bot, repo-associated) human, excluding our own feedback footer.
// PR open/close/merge has its own first-class handling and isn't a comment.
function extractEligiblePrComment(
  event: string,
  payload: WebhookPayload,
): EligiblePrComment | null {
  let body: string | null = null;
  let actor: GhActor = null;
  let authorAssociation: string | null = null;
  let commentUrl: string | null = null;
  let path: string | null = null;
  let line: number | null = null;
  let sourceId: string | null = null;
  if (event === "issue_comment" && payload.action === "created") {
    body = payload.comment?.body ?? null;
    actor = payload.comment?.user ?? null;
    authorAssociation = payload.comment?.author_association ?? null;
    commentUrl = payload.comment?.html_url ?? null;
    sourceId = payload.comment?.id != null ? `issue_comment:${payload.comment.id}` : null;
  } else if (event === "pull_request_review_comment" && payload.action === "created") {
    body = payload.comment?.body ?? null;
    actor = payload.comment?.user ?? null;
    authorAssociation = payload.comment?.author_association ?? null;
    commentUrl = payload.comment?.html_url ?? null;
    path = payload.comment?.path ?? null;
    line = payload.comment?.line ?? null;
    sourceId = payload.comment?.id != null ? `review_comment:${payload.comment.id}` : null;
  } else if (event === "pull_request_review" && payload.action === "submitted") {
    body = payload.review?.body ?? null;
    actor = payload.review?.user ?? null;
    authorAssociation = payload.review?.author_association ?? null;
    commentUrl = payload.review?.html_url ?? null;
    sourceId = payload.review?.id != null ? `review:${payload.review.id}` : null;
  } else {
    return null;
  }
  if (!body || body.trim().length === 0) return null;

  // Skip our own footer echoed back by the GitHub UI — the PR description
  // itself is rendered into comment-like contexts occasionally (e.g. the
  // squashed merge commit message), and we don't want our own "leave
  // feedback" link surfaced as feedback.
  if (body.includes(FEEDBACK_PR_FOOTER_MARKER)) return null;

  if (
    !isFeedbackEligibleCommenter({
      userType: actor?.type ?? null,
      authorAssociation,
    })
  ) {
    return null;
  }
  return { body, actor, commentUrl, path, line, sourceId };
}

// Review feedback on an agent PR continues the SAME investigation session where
// one survives (resume / steer, keeping the existing branch mounted), and only
// cold-starts a fresh run when no session can be resumed. `detail.origin`
// carries the comment so the worker routes the agent's reply back to the PR.
// The comment URL is a stable dedupe key against GitHub webhook redelivery.
async function maybeRequestPrCommentFollowUp(opts: {
  event: string;
  payload: WebhookPayload;
  agentPrRow: schema.AgentPullRequest;
}): Promise<void> {
  const comment = extractEligiblePrComment(opts.event, opts.payload);
  if (!comment) return;
  const result = await recordInboundInteraction(db, {
    incidentId: opts.agentPrRow.incidentId,
    interaction: {
      channel: "pr_comment",
      author: comment.actor?.login ?? null,
      // Prefix with which PR the feedback is on — an incident can have
      // several agent PRs, and the resumed session must know which one to
      // update and reply to.
      text: `[on PR #${opts.agentPrRow.prNumber} ${opts.agentPrRow.repoFullName}, branch \`${opts.agentPrRow.branchName}\`] ${comment.body}`,
      url: comment.commentUrl,
      path: comment.path,
      line: comment.line,
      occurredAt: new Date().toISOString(),
    },
    // Deterministic across GitHub webhook redelivery: stable comment/review id
    // first, then the comment URL. Both are stable for a given comment, so a
    // redelivery dedupes instead of enqueuing twice.
    dedupeKey: `github:${comment.sourceId ?? comment.commentUrl ?? `${opts.agentPrRow.id}:${comment.body}`}`,
  });
  if (result.outcome === "skipped") {
    log.info(
      { incident_id: opts.agentPrRow.incidentId, reason: result.reason },
      "pr comment did not continue the investigation",
    );
  }
}

async function maybeRecordPrCommentFeedback(opts: {
  event: string;
  payload: WebhookPayload;
  agentPrRow: schema.AgentPullRequest;
}): Promise<void> {
  const { event, payload, agentPrRow } = opts;
  const eligible = extractEligiblePrComment(event, payload);
  if (!eligible) return;
  const { body, actor, commentUrl } = eligible;

  // Resolve org + project via the agent PR's installation so the admin
  // inbox can show which org's PR this feedback is on.
  const install = await db.query.githubInstallations.findFirst({
    where: eq(schema.githubInstallations.id, agentPrRow.installationId),
  });

  // Best-effort idempotency: GitHub redelivers webhooks on failure (the
  // outer handler returns 500 on its own catch path), so a single PR
  // comment can hit us multiple times. The comment URL is a stable
  // natural key — skip if we've already recorded feedback for it. Not a
  // strict unique index because the dedupe window between delivery
  // retries is minutes, not concurrent; a hard guarantee would need a
  // unique partial index, which we may add later if duplicates show up.
  if (commentUrl) {
    const existing = await db.query.feedback.findFirst({
      where: and(
        eq(schema.feedback.source, "pr_comment"),
        sql`${schema.feedback.authorExternal}->>'githubCommentUrl' = ${commentUrl}`,
      ),
      columns: { id: true },
    });
    if (existing) return;
  }

  await recordFeedback({
    kind: "pr",
    refId: agentPrRow.id,
    refRepo: agentPrRow.repoFullName,
    source: "pr_comment",
    body,
    authorUserId: null,
    authorExternal: {
      githubLogin: actor?.login,
      githubCommentUrl: commentUrl ?? undefined,
    },
    orgId: install?.orgId ?? null,
    projectId: install?.projectId ?? null,
  });
}

function describeAgentPrEvent(
  event: string,
  payload: WebhookPayload,
): { kind: string | null; summary: string | null; actor: GhActor } {
  if (event === "pull_request") {
    const action = payload.action ?? "";
    const actor = payload.sender ?? payload.pull_request?.user ?? null;
    if (action === "closed") {
      const merged = payload.pull_request?.merged === true;
      return {
        kind: merged ? "pr_merged" : "pr_closed",
        summary: merged ? "PR merged" : "PR closed",
        actor: merged ? (payload.pull_request?.merged_by ?? actor) : actor,
      };
    }
    if (action === "reopened") return { kind: "pr_reopened", summary: "PR reopened", actor };
    if (action === "edited") return { kind: "pr_edited", summary: "PR edited", actor };
    if (action === "ready_for_review") {
      return { kind: "pr_ready_for_review", summary: "Marked ready for review", actor };
    }
    if (action === "converted_to_draft") {
      return { kind: "pr_converted_to_draft", summary: "Converted to draft", actor };
    }
    return { kind: null, summary: null, actor: null };
  }
  if (event === "pull_request_review") {
    if (payload.action !== "submitted") return { kind: null, summary: null, actor: null };
    const state = payload.review?.state ?? "commented";
    const summary = `Review submitted (${state})`;
    return {
      kind: `review_${state}`,
      summary,
      actor: payload.review?.user ?? payload.sender ?? null,
    };
  }
  if (event === "pull_request_review_comment") {
    if (payload.action !== "created") return { kind: null, summary: null, actor: null };
    return {
      kind: "review_comment",
      summary: "Inline review comment",
      actor: payload.comment?.user ?? payload.sender ?? null,
    };
  }
  if (event === "issue_comment") {
    if (payload.action !== "created") return { kind: null, summary: null, actor: null };
    return {
      kind: "issue_comment",
      summary: "Comment on PR",
      actor: payload.comment?.user ?? payload.sender ?? null,
    };
  }
  if (event === "push") {
    const count = payload.commits?.length ?? 0;
    return {
      kind: "commit_pushed",
      summary: `${count} commit${count === 1 ? "" : "s"} pushed`,
      actor: payload.sender ?? null,
    };
  }
  return { kind: null, summary: null, actor: null };
}

function toStoredRepo(r: GhRepo): StoredRepo {
  return { id: r.id, fullName: r.full_name, private: r.private };
}

// Upserts an installation row. Returns the row's PK id so callers can patch
// it (e.g. capture installer commit author).
//
// Both project- and org-scoped shapes use a partial unique index on the
// active rows for their respective key tuple. onConflict targets need the
// same WHERE clause as the index so postgres can match.
//
// The `set` payloads are effectively no-ops (any conflicting row already
// has revoked_at IS NULL by virtue of the partial-index WHERE clause; org_id
// is determined by project_id for the project-scoped case). They exist only
// because `DO UPDATE` makes RETURNING fire for the existing row, where
// `DO NOTHING` would return no row and force a second SELECT to get the id.
async function upsertInstallation(args: {
  orgId: string;
  projectId: string | null;
  installationId: number;
}): Promise<string> {
  if (args.projectId) {
    const [row] = await db
      .insert(schema.githubInstallations)
      .values({
        orgId: args.orgId,
        projectId: args.projectId,
        installationId: args.installationId,
      })
      .onConflictDoUpdate({
        target: [schema.githubInstallations.projectId, schema.githubInstallations.installationId],
        targetWhere: sql`project_id IS NOT NULL AND revoked_at IS NULL`,
        set: { orgId: args.orgId, revokedAt: null },
      })
      .returning({ id: schema.githubInstallations.id });
    if (!row) throw new Error("upsert returned no row");
    return row.id;
  }
  const [row] = await db
    .insert(schema.githubInstallations)
    .values({
      orgId: args.orgId,
      projectId: null,
      installationId: args.installationId,
    })
    .onConflictDoUpdate({
      target: [schema.githubInstallations.orgId, schema.githubInstallations.installationId],
      targetWhere: sql`project_id IS NULL AND revoked_at IS NULL`,
      set: { revokedAt: null },
    })
    .returning({ id: schema.githubInstallations.id });
  if (!row) throw new Error("insert returned no row");
  return row.id;
}

async function maybeCaptureInstallerIdentity(opts: {
  installationRowId: string;
  installationId: number;
  oauthCode: string | null;
  clientId: string | undefined;
  clientSecret: string | undefined;
  redirectUrl: string;
}): Promise<void> {
  if (!opts.oauthCode || !opts.clientId || !opts.clientSecret) return;
  try {
    const token = await exchangeGithubOAuthCode({
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      code: opts.oauthCode,
      redirectUrl: opts.redirectUrl,
    });
    const author = await fetchCommitAuthor(token);
    await db
      .update(schema.githubInstallations)
      .set({
        commitAuthorName: author.name,
        commitAuthorEmail: author.email,
        commitAuthorGithubLogin: author.githubLogin,
        commitAuthorGithubId: author.githubId,
        commitAuthorAvatarUrl: author.avatarUrl,
        commitAuthorSetAt: new Date(),
      })
      .where(eq(schema.githubInstallations.id, opts.installationRowId));
    log.info(
      {
        installation_row_id: opts.installationRowId,
        installation_id: opts.installationId,
        github_login: author.githubLogin,
      },
      "captured installer commit author from install OAuth",
    );
  } catch (err) {
    log.warn(
      { err, installation_row_id: opts.installationRowId, installation_id: opts.installationId },
      "failed to capture installer commit author; falling back to default",
    );
  }
}

function verifyWebhookSignature(body: string, header: string, secret: string): boolean {
  if (!header.startsWith("sha256=")) return false;
  const provided = Buffer.from(header.slice("sha256=".length), "hex");
  const expected = crypto.createHmac("sha256", secret).update(body).digest();
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}

function getGithubAppConfig(): { appId: string; privateKey: string } | null {
  const appId = process.env.GITHUB_APP_ID?.trim();
  const privateKey =
    process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n") ??
    (process.env.GITHUB_APP_PRIVATE_KEY_BASE64
      ? Buffer.from(process.env.GITHUB_APP_PRIVATE_KEY_BASE64, "base64").toString("utf8")
      : undefined);
  if (!appId || !privateKey) return null;
  return { appId, privateKey };
}

function signGithubAppJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iat: now - 60,
      exp: now + 9 * 60,
      iss: appId,
    }),
  ).toString("base64url");
  const signingInput = `${header}.${payload}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput), privateKey);
  return `${signingInput}.${signature.toString("base64url")}`;
}

async function githubRequest<T>(pathname: string, bearerToken: string): Promise<T> {
  const res = await fetch(`https://api.github.com${pathname}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${bearerToken}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "superlog-api",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`github GET ${pathname} failed: ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

type GithubPermission = "read" | "write";

async function createInstallationToken(opts: {
  installationId: number;
  permissions: Record<string, GithubPermission>;
}): Promise<string> {
  const cfg = getGithubAppConfig();
  if (!cfg) throw new Error("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required");
  const appJwt = signGithubAppJwt(cfg.appId, cfg.privateKey);
  const res = await fetch(
    `https://api.github.com/app/installations/${opts.installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${appJwt}`,
        "content-type": "application/json; charset=utf-8",
        "x-github-api-version": "2022-11-28",
        "user-agent": "superlog-api",
      },
      body: JSON.stringify({ permissions: opts.permissions }),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `github POST /app/installations/${opts.installationId}/access_tokens failed: ${res.status} ${text}`,
    );
  }
  const data = (await res.json()) as { token: string };
  return data.token;
}

async function createInstallationReadToken(installationId: number): Promise<string> {
  return createInstallationToken({ installationId, permissions: { contents: "read" } });
}

async function createInstallationWriteToken(installationId: number): Promise<string> {
  return createInstallationToken({
    installationId,
    permissions: { contents: "write", pull_requests: "write" },
  });
}

export async function mergeGithubPullRequest(opts: {
  installationId: number;
  repoFullName: string;
  prNumber: number;
  method: "squash" | "merge" | "rebase";
}): Promise<{ sha: string | null }> {
  const token = await createInstallationWriteToken(opts.installationId);
  const res = await fetch(
    `https://api.github.com/repos/${opts.repoFullName}/pulls/${opts.prNumber}/merge`,
    {
      method: "PUT",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
        "x-github-api-version": "2022-11-28",
        "user-agent": "superlog-api",
      },
      body: JSON.stringify({ merge_method: opts.method }),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`github PUT /pulls/${opts.prNumber}/merge failed: ${res.status} ${text}`);
  }
  const body = (await res.json().catch(() => ({}))) as { sha?: string };
  return { sha: body.sha ?? null };
}

export async function closeAgentPullRequestOnGithub(opts: {
  installationId: number;
  fallbackInstallationIds?: number[];
  repoFullName: string;
  prNumber: number;
  prNodeId?: string | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  return closeGithubPullRequestWithInstallations({
    installationIds: [opts.installationId, ...(opts.fallbackInstallationIds ?? [])],
    repoFullName: opts.repoFullName,
    prNumber: opts.prNumber,
    prNodeId: opts.prNodeId,
    userAgent: "superlog-api",
    createWriteToken: createInstallationWriteToken,
  });
}

export async function closeGithubPullRequestWithInstallations(opts: {
  installationIds: number[];
  repoFullName: string;
  prNumber: number;
  prNodeId?: string | null;
  userAgent: string;
  fetchImpl?: typeof fetch;
  createWriteToken: (installationId: number) => Promise<string>;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const errors: string[] = [];
  for (const installationId of dedupeInstallationIds(opts.installationIds)) {
    try {
      const token = await opts.createWriteToken(installationId);
      const result = await closeGithubPullRequestWithToken({
        token,
        repoFullName: opts.repoFullName,
        prNumber: opts.prNumber,
        prNodeId: opts.prNodeId,
        userAgent: opts.userAgent,
        fetchImpl: opts.fetchImpl,
      });
      if (result.ok) return result;
      errors.push(`installation ${installationId}: ${result.error}`);
    } catch (err) {
      errors.push(
        `installation ${installationId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { ok: false, error: errors.join("; ") || "no github installations available" };
}

export async function closeGithubPullRequestWithToken(opts: {
  token: string;
  repoFullName: string;
  prNumber: number;
  prNodeId?: string | null;
  userAgent: string;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const errors: string[] = [];
  if (opts.prNodeId) {
    const res = await fetchImpl("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${opts.token}`,
        "content-type": "application/json; charset=utf-8",
        "x-github-api-version": "2022-11-28",
        "user-agent": opts.userAgent,
      },
      body: JSON.stringify({
        query: `mutation ClosePullRequest($pullRequestId: ID!) {
          closePullRequest(input: { pullRequestId: $pullRequestId }) {
            pullRequest { id closed }
          }
        }`,
        variables: { pullRequestId: opts.prNodeId },
      }),
    });
    const text = await res.text().catch(() => "");
    if (res.ok) {
      const data = text ? parseGithubGraphqlResponse(text) : {};
      if (!data.errors?.length) return { ok: true };
    }
    errors.push(`github GraphQL closePullRequest ${res.status} ${text}`);
  }

  const res = await fetchImpl(
    `https://api.github.com/repos/${opts.repoFullName}/pulls/${opts.prNumber}`,
    {
      method: "PATCH",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${opts.token}`,
        "content-type": "application/json; charset=utf-8",
        "x-github-api-version": "2022-11-28",
        "user-agent": opts.userAgent,
      },
      body: JSON.stringify({ state: "closed" }),
    },
  );
  if (res.ok) return { ok: true };
  const text = await res.text().catch(() => "");
  errors.push(`github PATCH /pulls/${opts.prNumber} ${res.status} ${text}`);
  return { ok: false, error: errors.join("; ") };
}

function parseGithubGraphqlResponse(text: string): { errors?: unknown[] } {
  try {
    return JSON.parse(text) as { errors?: unknown[] };
  } catch {
    return { errors: [{ message: "invalid json response" }] };
  }
}

function dedupeInstallationIds(values: number[]): number[] {
  return [...new Set(values)];
}

// Safety ceiling on paginated GitHub list calls: 100 pages × 100 per page =
// 10k items. High enough to cover every realistic repo/branch count while
// still bounding the loop so a pathological account can't spin it forever.
const GITHUB_LIST_MAX_PAGES = 100;

export async function listCurrentInstallationRepos(installationId: number): Promise<StoredRepo[]> {
  const token = await createInstallationReadToken(installationId);
  const repos: StoredRepo[] = [];
  let page = 1;
  for (; page <= GITHUB_LIST_MAX_PAGES; page += 1) {
    const data = await githubRequest<GithubInstallationReposResponse>(
      `/installation/repositories?per_page=100&page=${page}`,
      token,
    );
    repos.push(...data.repositories.map(toStoredRepo));
    if (data.repositories.length < 100) break;
  }
  if (page > GITHUB_LIST_MAX_PAGES) {
    log.warn(
      { installationId, cap: GITHUB_LIST_MAX_PAGES * 100 },
      "installation repo list hit the pagination cap; results may be truncated",
    );
  }
  return repos;
}

// Direct, O(1) repo lookup that doesn't depend on paginating the install's
// full repo list. Used by the management-API grant flow: a 1000+ repo install
// would otherwise silently 404 anything past page 10 of the list. Returns
// null if the install's token can't see this repo (i.e. not covered).
export async function fetchInstallationRepoById(
  installationId: number,
  repoId: number,
): Promise<StoredRepo | null> {
  const token = await createInstallationReadToken(installationId);
  try {
    const data = await githubRequest<{ id: number; full_name: string; private: boolean }>(
      `/repositories/${repoId}`,
      token,
    );
    return { id: data.id, fullName: data.full_name, private: data.private };
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message.includes("failed: 404") || err.message.includes("failed: 403"))
    ) {
      return null;
    }
    throw err;
  }
}

async function fetchRepoBranchInfo(
  installationId: number,
  repoFullName: string,
): Promise<RepoBranchInfo> {
  const token = await createInstallationReadToken(installationId);
  const repo = await githubRequest<{ default_branch?: string }>(`/repos/${repoFullName}`, token);
  const branches: string[] = [];
  let page = 1;
  for (; page <= GITHUB_LIST_MAX_PAGES; page += 1) {
    const data = await githubRequest<{ name: string }[]>(
      `/repos/${repoFullName}/branches?per_page=100&page=${page}`,
      token,
    );
    branches.push(...data.map((b) => b.name));
    if (data.length < 100) break;
  }
  if (page > GITHUB_LIST_MAX_PAGES) {
    log.warn(
      { repo: repoFullName, cap: GITHUB_LIST_MAX_PAGES * 100 },
      "repo branch list hit the pagination cap; results may be truncated",
    );
  }
  return { defaultBranch: repo.default_branch ?? null, branches };
}

// Lists the branch set the agent could target for a project: the union of
// branches across every enabled repo the project's GitHub installation(s) can
// reach. `errored` is true when there were repos to inspect but every lookup
// failed (token/network), so callers can disable the picker instead of
// pretending the repo simply has no branches.
export async function listProjectRepoBranches(
  projectId: string,
): Promise<{ branches: RepoBranch[]; errored: boolean }> {
  const accessible = await listAccessibleGithubInstallsForProject(projectId);
  const perRepo: RepoBranchInfo[] = [];
  const seenRepos = new Set<string>();
  let sawError = false;
  for (const { installation: row, allowedRepoIds } of accessible) {
    if (!row.agentEnabled) continue;
    let repos: StoredRepo[];
    try {
      repos = await listCurrentInstallationRepos(row.installationId);
    } catch (err) {
      sawError = true;
      log.warn(
        { err, projectId, installationId: row.installationId },
        "github repository listing failed while loading branches",
      );
      continue;
    }
    const grantSet = allowedRepoIds === null ? null : new Set(allowedRepoIds);
    const repoAccess = normalizeRepoAccess(row.repoAccess);
    for (const repo of repos) {
      if (grantSet && !grantSet.has(repo.id)) continue;
      if (!isRepoEnabled(repoAccess, repo.id)) continue;
      if (seenRepos.has(repo.fullName)) continue;
      seenRepos.add(repo.fullName);
      try {
        perRepo.push(await fetchRepoBranchInfo(row.installationId, repo.fullName));
      } catch (err) {
        sawError = true;
        log.warn({ err, projectId, repo: repo.fullName }, "github branch listing failed for repo");
      }
    }
  }
  // Distinguish "GitHub call failed" from "project genuinely has no branches":
  // only flag errored when something broke AND we produced nothing, so a
  // partial failure still returns the branches we did manage to load.
  return { branches: mergeRepoBranches(perRepo), errored: sawError && perRepo.length === 0 };
}

// biome-ignore lint/suspicious/noExplicitAny: Hono Variables invariance.
export function mountGithubAuthed(app: Hono<any>): void {
  const appSlug = process.env.GITHUB_APP_SLUG;
  const oauthClientId =
    process.env.GITHUB_OAUTH_CLIENT_ID ??
    process.env.GITHUB_APP_CLIENT_ID ??
    process.env.GITHUB_CLIENT_ID;
  const oauthClientSecret =
    process.env.GITHUB_OAUTH_CLIENT_SECRET ??
    process.env.GITHUB_APP_CLIENT_SECRET ??
    process.env.GITHUB_CLIENT_SECRET;
  const stateSecret = process.env.STATE_SIGNING_SECRET;
  const authorRedirectUrl =
    process.env.GITHUB_AUTHOR_OAUTH_REDIRECT_URL ??
    `${process.env.BETTER_AUTH_URL ?? "http://localhost:4100"}/github/author/callback`;

  async function resolveActiveContext(
    userId: string | undefined,
    preferredOrgId?: string | null,
  ): Promise<{ orgId: string; projectId: string } | null> {
    if (!userId) return null;
    const ctx = await resolveActiveOrgContext({
      userId,
      preferredOrgId: preferredOrgId ?? null,
    }).catch(() => null);
    if (!ctx) return null;
    return { orgId: ctx.org.id, projectId: ctx.project.id };
  }

  app.get("/api/github/installation", async (c) => {
    const active = await resolveActiveContext(
      c.var.userId as string | undefined,
      c.var.orgId as string | null | undefined,
    );
    if (!active) return c.json({ installed: false });

    const accessible = await listAccessibleGithubInstallsForProject(active.projectId);
    if (accessible.length === 0) return c.json({ installed: false });

    const installations: GithubInstallationSummary[] = [];
    let repoVerificationUnavailable = false;
    for (const { installation: row, allowedRepoIds } of accessible) {
      let repos = Array.isArray(row.repos) ? (row.repos as StoredRepo[]) : [];
      try {
        repos = await listCurrentInstallationRepos(row.installationId);
      } catch (err) {
        log.warn(
          { err, projectId: active.projectId, installationId: row.installationId },
          "github repository listing failed",
        );
        if (
          err instanceof Error &&
          err.message.includes("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY")
        ) {
          repoVerificationUnavailable = true;
        }
        if (isMissingGithubInstallation(err)) {
          await db
            .update(schema.githubInstallations)
            .set({ revokedAt: new Date() })
            .where(eq(schema.githubInstallations.id, row.id));
          continue;
        }
      }
      const repoAccess = normalizeRepoAccess(row.repoAccess);
      // Granted org-scoped installs are restricted to the project's allowed
      // repo set; project-owned installs see everything in the install.
      const grantSet = allowedRepoIds === null ? null : new Set(allowedRepoIds);
      const scopedRepos = grantSet === null ? repos : repos.filter((repo) => grantSet.has(repo.id));
      installations.push({
        installationId: row.installationId,
        accountLogin: row.accountLogin,
        accountType: row.accountType,
        enabled: row.agentEnabled,
        manageUrl: githubInstallationManageUrl(row),
        repos: scopedRepos.map((repo) => ({
          ...repo,
          enabled: isRepoEnabled(repoAccess, repo.id),
        })),
      });
    }
    if (installations.length === 0) return c.json({ installed: false });

    const authorRow = accessible
      .map(({ installation }) => installation)
      .find((row) => row.commitAuthorName && row.commitAuthorEmail);
    const repos = dedupeRepoSummaries(
      installations.flatMap((installation) =>
        installation.repos.map((repo) => ({
          ...repo,
          enabled: installation.enabled && repo.enabled,
        })),
      ),
    );
    const firstInstallation = installations[0];
    if (!firstInstallation) return c.json({ installed: false });
    return c.json({
      installed: true,
      installationId: firstInstallation.installationId,
      accountLogin: firstInstallation.accountLogin,
      manageUrl: firstInstallation.manageUrl,
      repoVerificationUnavailable,
      installations,
      repos,
      commitAuthor:
        authorRow?.commitAuthorName && authorRow.commitAuthorEmail
          ? {
              source: "github_user",
              name: authorRow.commitAuthorName,
              email: authorRow.commitAuthorEmail,
              githubLogin: authorRow.commitAuthorGithubLogin,
              githubId: authorRow.commitAuthorGithubId,
              avatarUrl: authorRow.commitAuthorAvatarUrl,
              setAt: authorRow.commitAuthorSetAt?.toISOString() ?? null,
            }
          : {
              source: "app",
              name: DEFAULT_COMMIT_AUTHOR.name,
              email: DEFAULT_COMMIT_AUTHOR.email,
              githubLogin: null,
              githubId: null,
              avatarUrl: null,
              setAt: null,
            },
    });
  });

  app.post("/api/github/skip", async (c) => {
    const ctx = await resolveUserOrg(c);
    if (!ctx) return c.json({ error: "no org for user" }, 404);
    await db
      .update(schema.orgs)
      .set({ githubSetupSkippedAt: new Date() })
      .where(eq(schema.orgs.id, ctx.orgId));
    return c.json({ ok: true, orgId: ctx.orgId });
  });

  // Lands here after Better Auth completes GitHub OAuth. If the user's org
  // already has a GitHub App install we redirect back to the web app; if not,
  // we kick off the App install flow inline so signing in with GitHub
  // doubles as installing the App. The callbackURL passed from the web
  // client points at this endpoint; the cookie session is set by Better Auth
  // before the redirect lands here so `c.var.userId` is populated by the
  // /api/* middleware.
  app.get("/api/github/post-signin", async (c) => {
    const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:5173";
    const active = await resolveActiveContext(
      c.var.userId as string | undefined,
      c.var.orgId as string | null | undefined,
    );
    if (!active) return c.redirect(`${webOrigin}/`, 302);

    const installs = await listAccessibleGithubInstallsForProject(active.projectId);
    if (installs.length > 0) return c.redirect(`${webOrigin}/`, 302);

    if (!appSlug || !stateSecret) {
      // GitHub app not configured in this env — just send the user home so
      // they aren't stuck on a blank page.
      return c.redirect(`${webOrigin}/`, 302);
    }
    const state = signState("web", active.projectId, stateSecret);
    const url = new URL(`https://github.com/apps/${appSlug}/installations/new`);
    url.searchParams.set("state", state);
    return c.redirect(url.toString(), 302);
  });

  app.post("/api/github/install-url", async (c) => {
    if (!appSlug || !stateSecret) {
      return c.json({ error: "github app not configured" }, 503);
    }
    const active = await resolveActiveContext(
      c.var.userId as string | undefined,
      c.var.orgId as string | null | undefined,
    );
    if (!active) return c.json({ error: "no org for user" }, 404);

    // "web" state value is now the projectId; the callback resolves the org
    // from the project row.
    const state = signState("web", active.projectId, stateSecret);
    const url = new URL(`https://github.com/apps/${appSlug}/installations/new`);
    url.searchParams.set("state", state);
    log.info(
      { org_id: active.orgId, project_id: active.projectId, app_slug: appSlug },
      "github install url created",
    );
    return c.json({ url: url.toString() });
  });

  app.post("/api/github/repo-access", async (c) => {
    const ctx = await resolveUserOrg(c);
    if (!ctx) return c.json({ error: "no org for user" }, 404);

    const body = (await c.req.json().catch(() => null)) as {
      installationId?: unknown;
      enabled?: unknown;
      repoId?: unknown;
      repoEnabled?: unknown;
    } | null;
    const installationId = Number(body?.installationId);
    if (!Number.isFinite(installationId) || installationId <= 0) {
      return c.json({ error: "invalid installation id" }, 400);
    }

    const row = await db.query.githubInstallations.findFirst({
      where: and(
        eq(schema.githubInstallations.projectId, ctx.projectId),
        eq(schema.githubInstallations.installationId, installationId),
        isNull(schema.githubInstallations.revokedAt),
      ),
    });
    if (!row) return c.json({ error: "github installation not found" }, 404);

    const patch: {
      agentEnabled?: boolean;
      repoAccess?: RepoAccess;
    } = {};
    if (typeof body?.enabled === "boolean") {
      patch.agentEnabled = body.enabled;
    }
    if (body?.repoId !== undefined || body?.repoEnabled !== undefined) {
      const repoId = Number(body?.repoId);
      if (!Number.isFinite(repoId) || repoId <= 0 || typeof body?.repoEnabled !== "boolean") {
        return c.json({ error: "invalid repo access update" }, 400);
      }
      patch.repoAccess = setRepoEnabled(row.repoAccess, repoId, body.repoEnabled);
    }
    if (Object.keys(patch).length === 0) {
      return c.json({ error: "no repo access change provided" }, 400);
    }

    await db
      .update(schema.githubInstallations)
      .set(patch)
      .where(eq(schema.githubInstallations.id, row.id));
    return c.json({ ok: true });
  });

  app.post("/api/github/author-login-url", async (c) => {
    const ctx = await resolveUserOrg(c);
    if (!ctx) return c.json({ error: "no org for user" }, 404);

    if (!oauthClientId || !oauthClientSecret || !stateSecret) {
      if (!appSlug || !stateSecret) {
        return c.json({ error: "github oauth not configured" }, 503);
      }
      log.warn(
        { org_id: ctx.orgId, project_id: ctx.projectId },
        "github oauth not configured; falling back to app installation flow",
      );
      const state = signState("web", ctx.projectId, stateSecret);
      const url = new URL(`https://github.com/apps/${appSlug}/installations/new`);
      url.searchParams.set("state", state);
      return c.json({ url: url.toString() });
    }

    const state = signAuthorState(
      { orgId: ctx.orgId, projectId: ctx.projectId, userId: ctx.userId, purpose: "author" },
      stateSecret,
    );
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", oauthClientId);
    url.searchParams.set("redirect_uri", authorRedirectUrl);
    url.searchParams.set("scope", "read:user user:email");
    url.searchParams.set("state", state);
    return c.json({ url: url.toString() });
  });

  app.post("/api/github/access-login-url", async (c) => {
    const ctx = await resolveUserOrg(c);
    if (!ctx) return c.json({ error: "no org for user" }, 404);

    if (!oauthClientId || !oauthClientSecret || !stateSecret) {
      if (!appSlug || !stateSecret) {
        return c.json({ error: "github oauth not configured" }, 503);
      }
      log.warn(
        { org_id: ctx.orgId, project_id: ctx.projectId },
        "github oauth not configured; falling back to app installation flow",
      );
      const state = signState("web", ctx.projectId, stateSecret);
      const url = new URL(`https://github.com/apps/${appSlug}/installations/new`);
      url.searchParams.set("state", state);
      return c.json({ url: url.toString() });
    }

    const state = signAuthorState(
      { orgId: ctx.orgId, projectId: ctx.projectId, userId: ctx.userId, purpose: "access" },
      stateSecret,
    );
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", oauthClientId);
    url.searchParams.set("redirect_uri", authorRedirectUrl);
    url.searchParams.set("scope", "read:user user:email");
    url.searchParams.set("state", state);
    return c.json({ url: url.toString() });
  });

  app.post("/api/github/commit-author/reset", async (c) => {
    const ctx = await resolveUserOrg(c);
    if (!ctx) return c.json({ error: "no org for user" }, 404);

    await db
      .update(schema.githubInstallations)
      .set({
        commitAuthorName: null,
        commitAuthorEmail: null,
        commitAuthorGithubLogin: null,
        commitAuthorGithubId: null,
        commitAuthorAvatarUrl: null,
        commitAuthorSetByUserId: null,
        commitAuthorSetAt: null,
      })
      .where(
        and(
          eq(schema.githubInstallations.projectId, ctx.projectId),
          isNull(schema.githubInstallations.revokedAt),
        ),
      );
    return c.json({ ok: true });
  });
}

// biome-ignore lint/suspicious/noExplicitAny: Hono Variables invariance.
export function mountGithubAuthorOAuth(app: Hono<any>): void {
  const clientId =
    process.env.GITHUB_OAUTH_CLIENT_ID ??
    process.env.GITHUB_APP_CLIENT_ID ??
    process.env.GITHUB_CLIENT_ID;
  const clientSecret =
    process.env.GITHUB_OAUTH_CLIENT_SECRET ??
    process.env.GITHUB_APP_CLIENT_SECRET ??
    process.env.GITHUB_CLIENT_SECRET;
  const redirectUrl =
    process.env.GITHUB_AUTHOR_OAUTH_REDIRECT_URL ??
    `${process.env.BETTER_AUTH_URL ?? "http://localhost:4100"}/github/author/callback`;
  const stateSecret = process.env.STATE_SIGNING_SECRET;
  const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:5173";

  if (!clientId || !clientSecret) {
    log.warn("GITHUB_OAUTH_CLIENT_ID/SECRET not set — /github/author/callback disabled");
  }

  app.get("/github/author/callback", async (c) => {
    if (!clientId || !clientSecret || !stateSecret) {
      return c.json({ error: "github oauth not configured" }, 503);
    }
    const err = c.req.query("error");
    if (err) return c.redirect(`${webOrigin}/settings?github_author=denied`, 302);

    const code = c.req.query("code");
    const state = c.req.query("state") ?? "";
    if (!code) return c.redirect(`${webOrigin}/settings?github_author=error`, 302);

    const decoded = verifyAuthorState(state, stateSecret);
    if (!decoded) return c.json({ error: "invalid state" }, 400);

    let token: string;
    try {
      token = await exchangeGithubOAuthCode({ clientId, clientSecret, code, redirectUrl });
    } catch (e) {
      log.error({ err: e, org_id: decoded.orgId }, "github author oauth exchange failed");
      return c.redirect(`${webOrigin}/settings?github_author=error`, 302);
    }

    let author: CommitAuthor | null = null;
    let installations: GithubUserInstallation[];
    let reposByInstallation: Map<number, StoredRepo[]>;
    try {
      [author, installations] =
        decoded.purpose === "author"
          ? await Promise.all([fetchCommitAuthor(token), listUserAccessibleInstallations(token)])
          : [null, await listUserAccessibleInstallations(token)];
      reposByInstallation = new Map(
        await Promise.all(
          installations.map(
            async (installation) =>
              [installation.id, await listUserAccessibleRepos(token, installation.id)] as const,
          ),
        ),
      );
    } catch (e) {
      log.error({ err: e, org_id: decoded.orgId }, "github author fetch failed");
      return c.redirect(`${webOrigin}/settings?github_author=error`, 302);
    }

    if (installations.length === 0) {
      log.info(
        { org_id: decoded.orgId, user_id: decoded.userId, github_login: author?.githubLogin },
        "github oauth connected but no accessible app installation found",
      );
      const param = decoded.purpose === "author" ? "github_author" : "github";
      return c.redirect(`${webOrigin}/settings?${param}=no_install`, 302);
    }

    const upserted = await db.transaction(async (tx) => {
      const rows: Array<{ id: string }> = [];
      for (const installation of installations) {
        const repos = reposByInstallation.get(installation.id) ?? [];
        const inserted = await tx
          .insert(schema.githubInstallations)
          .values({
            orgId: decoded.orgId,
            projectId: decoded.projectId,
            installationId: installation.id,
            accountLogin: installation.account?.login ?? null,
            accountType: installation.account?.type ?? null,
            repos,
            ...(author
              ? {
                  commitAuthorName: author.name,
                  commitAuthorEmail: author.email,
                  commitAuthorGithubLogin: author.githubLogin,
                  commitAuthorGithubId: author.githubId,
                  commitAuthorAvatarUrl: author.avatarUrl,
                  commitAuthorSetByUserId: decoded.userId,
                  commitAuthorSetAt: new Date(),
                }
              : {}),
            revokedAt: null,
          })
          .onConflictDoUpdate({
            target: [
              schema.githubInstallations.projectId,
              schema.githubInstallations.installationId,
            ],
            targetWhere: sql`project_id IS NOT NULL AND revoked_at IS NULL`,
            set: {
              orgId: decoded.orgId,
              accountLogin: installation.account?.login ?? null,
              accountType: installation.account?.type ?? null,
              repos,
              ...(author
                ? {
                    commitAuthorName: author.name,
                    commitAuthorEmail: author.email,
                    commitAuthorGithubLogin: author.githubLogin,
                    commitAuthorGithubId: author.githubId,
                    commitAuthorAvatarUrl: author.avatarUrl,
                    commitAuthorSetByUserId: decoded.userId,
                    commitAuthorSetAt: new Date(),
                  }
                : {}),
              revokedAt: null,
            },
          })
          .returning({ id: schema.githubInstallations.id });
        rows.push(...inserted);
      }
      if (author) {
        await tx
          .update(schema.githubInstallations)
          .set({
            commitAuthorName: author.name,
            commitAuthorEmail: author.email,
            commitAuthorGithubLogin: author.githubLogin,
            commitAuthorGithubId: author.githubId,
            commitAuthorAvatarUrl: author.avatarUrl,
            commitAuthorSetByUserId: decoded.userId,
            commitAuthorSetAt: new Date(),
          })
          .where(
            and(
              eq(schema.githubInstallations.projectId, decoded.projectId),
              isNull(schema.githubInstallations.revokedAt),
            ),
          );
      }
      return rows;
    });

    log.info(
      {
        org_id: decoded.orgId,
        user_id: decoded.userId,
        github_login: author?.githubLogin,
        purpose: decoded.purpose,
        installation_ids: installations.map((installation) => installation.id),
        installation_row_ids: upserted.map((row) => row.id),
      },
      "github installations reconciled from user oauth",
    );
    void syncLoopsContactsForOrg({ orgId: decoded.orgId, appUrl: webOrigin }).catch((err) => {
      log.warn({ err, org_id: decoded.orgId }, "loops contact sync failed after github connect");
    });
    if (decoded.purpose === "author") {
      return c.redirect(`${webOrigin}/settings?github_author=connected`, 302);
    }
    // access flow: send back to root so the gate can pick up and show onboarding
    return c.redirect(`${webOrigin}/`, 302);
  });
}

async function exchangeGithubOAuthCode(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUrl: string;
}): Promise<string> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "superlog-api",
    },
    body: JSON.stringify({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      code: opts.code,
      redirect_uri: opts.redirectUrl,
    }),
  });
  const data = (await res.json()) as GithubOAuthTokenResponse;
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description ?? data.error ?? `github oauth failed: ${res.status}`);
  }
  return data.access_token;
}

async function githubUserRequest<T>(pathname: string, token: string): Promise<T> {
  const res = await fetch(`https://api.github.com${pathname}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "superlog-api",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`github GET ${pathname} failed: ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

async function fetchCommitAuthor(token: string): Promise<CommitAuthor> {
  const viewer = await githubUserRequest<GithubViewerResponse>("/user", token);
  let emails: GithubEmailResponse[] = [];
  try {
    emails = await githubUserRequest<GithubEmailResponse[]>("/user/emails", token);
  } catch (err) {
    log.warn(
      { err, github_login: viewer.login },
      "github user emails unavailable; falling back to profile or noreply email",
    );
  }
  const selectedEmail =
    emails.find((email) => email.primary && email.verified)?.email ??
    emails.find((email) => email.verified)?.email ??
    viewer.email ??
    `${viewer.id}+${viewer.login}@users.noreply.github.com`;
  const name = sanitizeGitName(viewer.name ?? viewer.login);
  const email = sanitizeGitEmail(selectedEmail);
  if (!name || !email) throw new Error("github profile did not provide a usable git identity");
  return {
    name,
    email,
    githubLogin: viewer.login,
    githubId: viewer.id,
    avatarUrl: viewer.avatar_url,
  };
}

async function listUserAccessibleInstallations(token: string): Promise<GithubUserInstallation[]> {
  const installs: GithubUserInstallation[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const data = await githubUserRequest<GithubUserInstallationsResponse>(
      `/user/installations?per_page=100&page=${page}`,
      token,
    );
    installs.push(...data.installations);
    if (data.installations.length < 100) break;
  }

  return installs.filter((installation) => !installation.suspended_at);
}

function githubInstallationManageUrl(installation: {
  installationId: number;
  accountLogin: string | null;
  accountType: string | null;
}): string {
  if (installation.accountType === "Organization" && installation.accountLogin) {
    return `https://github.com/organizations/${installation.accountLogin}/settings/installations/${installation.installationId}`;
  }
  return `https://github.com/settings/installations/${installation.installationId}`;
}

function isMissingGithubInstallation(err: unknown): boolean {
  return err instanceof Error && err.message.includes("failed: 404");
}

function normalizeRepoAccess(value: unknown): RepoAccess {
  if (!value || typeof value !== "object") return {};
  const disabledRepoIds = (value as RepoAccess).disabledRepoIds;
  if (!Array.isArray(disabledRepoIds)) return {};
  return {
    disabledRepoIds: [
      ...new Set(disabledRepoIds.filter((id): id is number => Number.isFinite(id) && id > 0)),
    ],
  };
}

function isRepoEnabled(repoAccess: RepoAccess, repoId: number): boolean {
  return !(repoAccess.disabledRepoIds ?? []).includes(repoId);
}

function setRepoEnabled(value: unknown, repoId: number, enabled: boolean): RepoAccess {
  const repoAccess = normalizeRepoAccess(value);
  const disabled = new Set(repoAccess.disabledRepoIds ?? []);
  if (enabled) {
    disabled.delete(repoId);
  } else {
    disabled.add(repoId);
  }
  return { disabledRepoIds: [...disabled].sort((a, b) => a - b) };
}

function dedupeRepoSummaries(repos: GithubRepoSummary[]): GithubRepoSummary[] {
  const seen = new Set<string>();
  const deduped: GithubRepoSummary[] = [];
  for (const repo of repos) {
    const existing = deduped.find((item) => item.fullName === repo.fullName);
    if (existing) {
      existing.enabled = existing.enabled || repo.enabled;
      continue;
    }
    if (!seen.has(repo.fullName)) {
      seen.add(repo.fullName);
      deduped.push({ ...repo });
    }
  }
  return deduped;
}

async function listUserAccessibleRepos(
  token: string,
  installationId: number,
): Promise<StoredRepo[]> {
  const repos: StoredRepo[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const data = await githubUserRequest<GithubUserInstallationReposResponse>(
      `/user/installations/${installationId}/repositories?per_page=100&page=${page}`,
      token,
    );
    repos.push(...data.repositories.map(toStoredRepo));
    if (data.repositories.length < 100) break;
  }
  return repos;
}

function sanitizeGitName(value: string): string | null {
  const cleaned = value
    .replace(/[\r\n<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || null;
}

function sanitizeGitEmail(value: string): string | null {
  const cleaned = value.trim();
  if (!cleaned || /[\r\n<>]/.test(cleaned) || !cleaned.includes("@")) return null;
  return cleaned;
}

async function resolveUserOrg(
  c: Context<{ Variables: Vars }>,
): Promise<{ userId: string; orgId: string; projectId: string } | null> {
  const userId = c.var.userId as string | undefined;
  if (!userId) return null;
  const ctx = await resolveActiveOrgContext({
    userId,
    preferredOrgId: c.var.orgId as string | null | undefined,
  }).catch(() => null);
  if (!ctx) return null;
  return { userId: ctx.user.id, orgId: ctx.org.id, projectId: ctx.project.id };
}

type AuthorStatePayload = {
  orgId: string;
  projectId: string;
  userId: string;
  purpose: "access" | "author";
};

function signAuthorState(p: AuthorStatePayload, secret: string): string {
  const body = `${p.orgId}.${p.projectId}.${p.userId}.${p.purpose}.${Date.now()}`;
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${Buffer.from(body, "utf8").toString("base64url")}.${sig}`;
}

function verifyAuthorState(state: string, secret: string): AuthorStatePayload | null {
  const [payloadB64, sig] = state.split(".");
  if (!payloadB64 || !sig) return null;
  const body = Buffer.from(payloadB64, "base64url").toString("utf8");
  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  const provided = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (provided.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(provided, expectedBuf)) return null;
  // Current format is `${orgId}.${projectId}.${userId}.${purpose}.${ts}` (5
  // parts). Old 3- or 4-part states (no projectId) are rejected — 10-min TTL
  // means worst case is users mid-flow during deploy clicking again.
  const parts = body.split(".");
  if (parts.length !== 5) return null;
  const [orgId, projectId, userId, purpose, tsRaw] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (!orgId || !projectId || !userId || !tsRaw) return null;
  if (purpose !== "access" && purpose !== "author") return null;
  const ts = Number(tsRaw);
  if (!Number.isFinite(ts) || Date.now() - ts > 10 * 60 * 1000) return null;
  return { orgId, projectId, userId, purpose };
}

type StateKind = "cli" | "web";

function signState(kind: StateKind, value: string, secret: string): string {
  const payload = `${kind}.${value}.${Date.now()}`;
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${base64url(payload)}.${sig}`;
}

function verifyState(state: string, secret: string): { kind: StateKind; value: string } | null {
  const [payloadB64, sig] = state.split(".");
  if (!payloadB64 || !sig) return null;
  const payload = Buffer.from(payloadB64, "base64url").toString("utf8");
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const [kind, value, tsRaw] = payload.split(".");
  if ((kind !== "cli" && kind !== "web") || !value || !tsRaw) return null;
  const ts = Number(tsRaw);
  // Match device code TTL: 10 min window.
  if (!Number.isFinite(ts) || Date.now() - ts > 10 * 60 * 1000) return null;
  return { kind, value };
}

// Management-API install state. Used when a platform backend mints an install
// URL via /api/v1/...; the state encodes scope (org vs project) and an
// optional return URL the user is bounced to after install. 30-min TTL since
// the customer's operator might not click immediately.
const MGMT_STATE_PREFIX = "mgmt-v1";
export type GithubMgmtState =
  | { scope: "org"; orgId: string; returnUrl: string | null }
  | { scope: "project"; projectId: string; returnUrl: string | null };

function signMgmtState(payload: GithubMgmtState, secret: string): string {
  const body = `${MGMT_STATE_PREFIX}.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}.${Date.now()}`;
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${Buffer.from(body, "utf8").toString("base64url")}.${sig}`;
}

function verifyMgmtState(state: string, secret: string): GithubMgmtState | null {
  const [payloadB64, sig] = state.split(".");
  if (!payloadB64 || !sig) return null;
  const body = Buffer.from(payloadB64, "base64url").toString("utf8");
  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  const provided = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (provided.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(provided, expectedBuf)) return null;
  const parts = body.split(".");
  if (parts.length !== 3 || parts[0] !== MGMT_STATE_PREFIX) return null;
  const ts = Number(parts[2]);
  if (!Number.isFinite(ts) || Date.now() - ts > 30 * 60 * 1000) return null;
  try {
    const json = Buffer.from(parts[1] as string, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as Partial<GithubMgmtState>;
    if (parsed.scope === "org" && typeof parsed.orgId === "string") {
      return { scope: "org", orgId: parsed.orgId, returnUrl: parsed.returnUrl ?? null };
    }
    if (parsed.scope === "project" && typeof parsed.projectId === "string") {
      return { scope: "project", projectId: parsed.projectId, returnUrl: parsed.returnUrl ?? null };
    }
    return null;
  } catch {
    return null;
  }
}

// Public helper used by the management API to mint install URLs without
// touching state internals.
export function buildGithubMgmtInstallUrl(args: GithubMgmtState): { url: string } | null {
  const appSlug = process.env.GITHUB_APP_SLUG;
  const stateSecret = process.env.STATE_SIGNING_SECRET;
  if (!appSlug || !stateSecret) return null;
  const state = signMgmtState(args, stateSecret);
  const url = new URL(`https://github.com/apps/${appSlug}/installations/new`);
  url.searchParams.set("state", state);
  return { url: url.toString() };
}

function base64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}
