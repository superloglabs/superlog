import { db, schema } from "@superlog/db";
import { and, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { auth } from "./auth.js";
import { offerFollowUpForFeedback } from "./follow-up-offer.js";
import { logger } from "./logger.js";

const log = logger.child({ scope: "feedback" });

const MAX_BODY_LEN = 8_000;
const FEEDBACK_KINDS = new Set<schema.FeedbackKind>(["incident", "issue", "pr"]);

// Public + authed routes share one mount because the PR-link page must be
// reachable without a session (external GitHub PR participants).
//
// /api/feedback (authed) is for the in-product dialog on incident/issue
// drawers — the session middleware in index.ts wraps it. /feedback/pr/...
// is mounted before the session middleware so it's open to anonymous
// submitters. The github.ts webhook handler inserts feedback rows directly
// via the helper below; same for the Slack interactivity handler.
//
// Every insert path funnels through `recordFeedback` so the Slack notifier
// and admin-inbox bookkeeping stay in one place.

// biome-ignore lint/suspicious/noExplicitAny: Hono Variables invariance.
export function mountFeedbackPublic(app: Hono<any>): void {
  // Anonymous PR-link submissions. We accept these without a session because
  // the link is included in PR descriptions on customer repos, and many
  // commenters won't have Superlog accounts. Rate-limiting is intentionally
  // out-of-scope for v1 — the form is one click deep, the admin inbox is
  // staff-only, and we can lock it down if it gets abused.
  app.post("/feedback/pr/:owner/:repo/:number", async (c) => {
    const owner = c.req.param("owner");
    const repo = c.req.param("repo");
    const number = Number(c.req.param("number"));
    if (!owner || !repo || !Number.isFinite(number) || number <= 0) {
      throw new HTTPException(400, { message: "invalid pr ref" });
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      body?: unknown;
      githubLogin?: unknown;
    };
    const text = typeof body.body === "string" ? body.body.trim() : "";
    if (!text) throw new HTTPException(400, { message: "body required" });
    if (text.length > MAX_BODY_LEN) {
      throw new HTTPException(400, { message: "body too long" });
    }
    const githubLogin = typeof body.githubLogin === "string" ? body.githubLogin.trim() : "";

    // Look up the agent PR row if we know about it — best-effort, the
    // feedback is recorded either way. ref_id is the agent_pull_requests.id
    // when we have it, otherwise we fall back to "owner/repo#number" so the
    // admin still has something to click.
    const repoFullName = `${owner}/${repo}`;
    const agentPr = await db.query.agentPullRequests.findFirst({
      where: and(
        eq(schema.agentPullRequests.repoFullName, repoFullName),
        eq(schema.agentPullRequests.prNumber, number),
      ),
    });

    // Try to grab the session cookie if the user happens to be signed in —
    // that lets us attribute the feedback to a known Superlog user even
    // though the route is public. Best-effort.
    let authorUserId: string | null = null;
    try {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      authorUserId = session?.user.id ?? null;
    } catch {
      authorUserId = null;
    }

    await recordFeedback({
      kind: "pr",
      refId: agentPr?.id ?? `${repoFullName}#${number}`,
      refRepo: repoFullName,
      source: "pr_link",
      body: text,
      authorUserId,
      authorExternal: githubLogin ? { githubLogin } : null,
      orgId: null,
      projectId: null,
    });

    return c.json({ ok: true });
  });
}

// biome-ignore lint/suspicious/noExplicitAny: Hono Variables invariance.
export function mountFeedbackAuthed(app: Hono<any>): void {
  // In-product dialog. The dialog is rendered on incident and issue
  // drawers, so kind is always 'incident' or 'issue'. We trust the caller
  // to pass the correct ref_id (incident or issue UUID); we don't gate on
  // whether the user can actually see that incident — feedback is an
  // unauth'd-by-design signal and the admin inbox is the only thing that
  // reads it.
  app.post("/api/feedback", async (c) => {
    const userId = c.var.userId as string;
    const body = (await c.req.json().catch(() => ({}))) as {
      kind?: unknown;
      refId?: unknown;
      body?: unknown;
      projectId?: unknown;
    };
    const kind = typeof body.kind === "string" ? body.kind : "";
    if (!FEEDBACK_KINDS.has(kind as schema.FeedbackKind) || kind === "pr") {
      // PR feedback comes in via /feedback/pr/* (anonymous) or the github
      // webhook; the in-product dialog only fires on incident/issue pages.
      throw new HTTPException(400, { message: "kind must be 'incident' or 'issue'" });
    }
    const refId = typeof body.refId === "string" ? body.refId : "";
    if (!refId) throw new HTTPException(400, { message: "refId required" });
    const text = typeof body.body === "string" ? body.body.trim() : "";
    if (!text) throw new HTTPException(400, { message: "body required" });
    if (text.length > MAX_BODY_LEN) {
      throw new HTTPException(400, { message: "body too long" });
    }
    // Resolve projectId via lookup before we trust it. A garbage string
    // (non-UUID syntax, or a stale ID whose project was deleted) would
    // otherwise hit the feedback.project_id FK and 500 on insert. We
    // wrap the lookup in try/catch because postgres throws a `22P02`
    // syntax error rather than returning empty for malformed UUIDs.
    const requestedProjectId = typeof body.projectId === "string" ? body.projectId : null;
    let projectId: string | null = null;
    let orgId: string | null = null;
    if (requestedProjectId) {
      const project = await db.query.projects
        .findFirst({ where: eq(schema.projects.id, requestedProjectId) })
        .catch(() => null);
      if (project) {
        projectId = project.id;
        orgId = project.orgId;
      }
    }

    await recordFeedback({
      kind: kind as "incident" | "issue",
      refId,
      refRepo: null,
      source: "dialog",
      body: text,
      authorUserId: userId,
      authorExternal: null,
      orgId,
      projectId,
    });

    return c.json({ ok: true });
  });

  // Staff triage reads the same `feedback` table directly.
}

// Shared insert + notify. Exported so the github webhook handler and Slack
// view_submission handler can call it directly without re-implementing the
// shape contract.
export async function recordFeedback(input: {
  kind: schema.FeedbackKind;
  refId: string;
  refRepo: string | null;
  source: schema.FeedbackSource;
  body: string;
  authorUserId: string | null;
  authorExternal: schema.FeedbackAuthorExternal | null;
  orgId: string | null;
  projectId: string | null;
}): Promise<void> {
  const [row] = await db
    .insert(schema.feedback)
    .values({
      kind: input.kind,
      refId: input.refId,
      refRepo: input.refRepo,
      source: input.source,
      body: input.body,
      authorUserId: input.authorUserId,
      authorExternal: input.authorExternal,
      orgId: input.orgId,
      projectId: input.projectId,
    })
    .returning();
  log.info(
    {
      feedback_id: row?.id,
      kind: input.kind,
      source: input.source,
      ref_id: input.refId,
      author_user_id: input.authorUserId,
    },
    "feedback recorded",
  );
  if (row) {
    void notifyFeedbackSlack(row).catch((err) => {
      log.warn({ err, feedback_id: row.id }, "feedback slack notify failed");
    });
    // Confirm-gated follow-up: offer a "Run follow-up" button in the
    // incident's Slack thread (no-op for pr_comment feedback, which
    // auto-triggers from the webhook path instead).
    void offerFollowUpForFeedback(row).catch((err) => {
      log.warn({ err, feedback_id: row.id }, "follow-up offer failed");
    });
  }
}

// Posts a one-liner to FEEDBACK_SLACK_WEBHOOK so the team hears about new
// feedback in real time. Best-effort — failures are logged and swallowed
// so they never block the insert path. Configure FEEDBACK_SLACK_WEBHOOK to
// a Slack incoming webhook URL (Slack app → Incoming Webhooks → pick a
// channel). Leave unset to disable.
async function notifyFeedbackSlack(row: schema.Feedback): Promise<void> {
  const webhookUrl = process.env.FEEDBACK_SLACK_WEBHOOK;
  if (!webhookUrl) return;
  // Optional staff tooling deep link. Unset -> no deep link.
  const adminOrigin = process.env.ADMIN_WEB_ORIGIN;
  const link = adminOrigin ? `${adminOrigin}/feedback?id=${row.id}` : null;
  const preview = row.body.length > 280 ? `${row.body.slice(0, 277)}…` : row.body;
  let authorEmail: string | null = null;
  if (row.authorUserId) {
    const user = await db.query.users.findFirst({
      where: eq(schema.users.id, row.authorUserId),
    });
    authorEmail = user?.email ?? null;
  }
  const author = authorEmail
    ? authorEmail
    : row.authorExternal?.githubLogin
      ? `@${row.authorExternal.githubLogin} (github)`
      : row.authorExternal?.slackUserId
        ? `<@${row.authorExternal.slackUserId}> (slack)`
        : "anonymous";
  // For PR feedback the refId is either an agent_pull_requests UUID (when
  // we know the PR — happens for PR-comment webhooks and for /feedback/pr/*
  // POSTs that match an agent PR row) or the fallback "owner/repo#number"
  // string from feedback.ts:79 (when the link was hit for a PR we don't
  // track). The UUID case needs the repo name prepended; the fallback case
  // already includes it, so re-prepending makes "owner/repo#…" appear twice.
  // Detect UUIDs by length (36) + presence of dashes.
  const refDesc =
    row.kind === "pr"
      ? row.refId.includes("#")
        ? `PR ${row.refId}`
        : `PR ${row.refRepo ?? ""} (${row.refId.slice(0, 8)}…)`
      : `${row.kind} ${row.refId.slice(0, 8)}…`;
  const text = `:speech_balloon: *New feedback* on ${refDesc} via _${row.source}_ from ${author}\n>${preview}${
    link ? `\n<${link}|Open in admin>` : ""
  }`;
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      log.warn({ status: res.status }, "feedback slack webhook returned non-2xx");
    }
  } catch (err) {
    log.warn({ err }, "feedback slack webhook fetch failed");
  }
}

// Used by github.ts to decide whether a PR comment counts as feedback.
// Greptile and other bot accounts have type='Bot'; their reviews are
// review-bot output, not user feedback. The author_association check
// keeps us from accepting drive-by comments from random GitHub users
// who happened to wander in — feedback should come from people who
// have a real relationship with the PR.
//
// Possible author_associations: OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR,
// FIRST_TIME_CONTRIBUTOR, FIRST_TIMER, MANNEQUIN, NONE.
const FEEDBACK_ASSOCIATIONS = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
  "CONTRIBUTOR",
  "FIRST_TIME_CONTRIBUTOR",
]);

export function isFeedbackEligibleCommenter(opts: {
  userType?: string | null;
  authorAssociation?: string | null;
}): boolean {
  if (opts.userType === "Bot") return false;
  if (!opts.authorAssociation) return false;
  return FEEDBACK_ASSOCIATIONS.has(opts.authorAssociation);
}

// Used by the dropped FEEDBACK_SLACK_WEBHOOK notifier — exported so tests
// can confirm the env var is honored without invoking fetch.
export function feedbackSlackWebhookConfigured(): boolean {
  return !!process.env.FEEDBACK_SLACK_WEBHOOK;
}

// Marker used by the github webhook to filter out our own footer so we
// don't surface our own link as feedback when GitHub echoes it back.
// The footer string itself is rendered by `renderFeedbackFooter` in
// apps/worker/src/github-app.ts (worker can't import from the api app),
// so any change to the URL path there needs to be mirrored here. The
// path `/feedback/pr/` is wired to a router pattern and is unlikely to
// move; matching on it (rather than the whole footer text) keeps this
// resilient to copy edits in the footer.
export const FEEDBACK_PR_FOOTER_MARKER = "/feedback/pr/";

// Used by the admin inbox query — also exported to keep the
// authorAssociation list in one place. Tests import this set directly.
export { FEEDBACK_ASSOCIATIONS };
