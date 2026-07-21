import crypto from "node:crypto";
import {
  type IncidentResolutionProof,
  confirmResolutionProposal,
  db,
  dismissResolutionProposal,
  findChatByAnchor,
  loadCurrentIncidentResolutionProof,
  mentionsBot,
  recordInboundChatMessage,
  recordInboundInteraction,
  requestFollowUpAgentRun,
  resolveChatInstallation,
  resolveIncidentWithProof,
  retryBlockedAgentRun,
  schema,
  stripBotMention,
  syncLoopsContactsForOrg,
  unsilenceIncidentIssues,
} from "@superlog/db";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { attachFeedbackDetail, recordFeedback } from "./feedback.js";
import { resolveFeedbackIncidentId } from "./follow-up-offer.js";
import { getDeviceFlow, getSkillDeviceForIntegration } from "./gateway.js";
import { closeAgentPullRequestOnGithub, reopenAgentPullRequestOnGithub } from "./github.js";
import { runResolvedIncidentSideEffectsForIncident } from "./incidents/resolution-side-effects.js";
import { logger } from "./logger.js";
import { requireProjectManagerContext } from "./org-authorization-http.js";
import { hasProjectManagerAccess } from "./org-authorization.js";
import { resolveActiveOrgContext } from "./org-context.js";
import { mergeAgentPullRequestAndResolveIncident } from "./pr-merge-service.js";
import { classifyIncidentSlackReply } from "./slack-reply-intent.js";

const log = logger.child({ scope: "slack" });

// `app_mentions:read` and `im:history` serve the Q&A chat (@-mentions and
// DMs). Existing installations predating them keep working: channel mentions
// also arrive as plain `message` events, which the chat router matches by
// bot-user id. Only DMs strictly need the new scope (and thus a reinstall).
//
// `channels:join` lets the bot join the notification channel itself. Posting
// only needs chat:write.public, but the Events API delivers channel messages
// solely for channels the bot is a MEMBER of — without joining, thread
// replies to the agent vanish silently. `users:read` (resolve author ids to
// names in transcripts/chats) and `reactions:write` (emoji acks) ride along
// so the next feature doesn't force yet another reinstall wave.
const SCOPES =
  "chat:write,chat:write.public,channels:read,groups:read,channels:history,groups:history,app_mentions:read,im:history,channels:join,users:read,reactions:write";

type Vars = { userId: string; orgId: string | null };

export type SlackResolveClickDisposition = "resolve" | "refresh_side_effects";

export function resolveSlackResolveClickDisposition(status: string): SlackResolveClickDisposition {
  return status === "open" ? "resolve" : "refresh_side_effects";
}

export function isRevokedSlackAuthError(error: string): boolean {
  return (
    error === "not_authed" ||
    error === "token_revoked" ||
    error === "invalid_auth" ||
    error === "account_inactive"
  );
}

// biome-ignore lint/suspicious/noExplicitAny: Hono Variables invariance.
export function mountSlackPublic(app: Hono<any>): void {
  const clientId = process.env.SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET;
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  const redirectUrl =
    process.env.SLACK_OAUTH_REDIRECT_URL ?? "http://localhost:4100/slack/oauth/callback";
  const stateSecret = process.env.STATE_SIGNING_SECRET;
  const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:5173";

  if (!clientId || !clientSecret) {
    log.warn("SLACK_CLIENT_ID/SECRET not set — /slack/oauth/callback disabled");
  }

  // Public Slack-install kickoff for the agent skill: skill receives the
  // user_code from the device flow and opens this URL in the user's browser
  // post-pairing. We look up the org from the user_code, sign cli-kind state,
  // and redirect to Slack's OAuth. Mirrors `/github/install?user_code=…`.
  app.get("/slack/install", (c) => {
    if (!clientId || !stateSecret) {
      return c.json({ error: "slack not configured" }, 503);
    }
    const callbackRedirectUrl = resolveSlackRedirectUrl(c, redirectUrl);
    const userCode = (c.req.query("user_code") ?? "").toUpperCase();
    const device = getSkillDeviceForIntegration(userCode);
    if (!device) return c.json({ error: "unknown or not-ready device code" }, 404);
    const state = signState(
      { orgId: device.orgId, projectId: device.projectId, userId: null, userCode },
      stateSecret,
    );
    const url = new URL("https://slack.com/oauth/v2/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("scope", SCOPES);
    url.searchParams.set("redirect_uri", callbackRedirectUrl);
    url.searchParams.set("state", state);
    return c.redirect(url.toString(), 302);
  });

  app.get("/slack/oauth/callback", async (c) => {
    if (!clientId || !clientSecret || !stateSecret) {
      return c.json({ error: "slack not configured" }, 503);
    }
    const callbackWebOrigin = resolveCallbackWebOrigin(c, webOrigin);
    const callbackRedirectUrl = resolveSlackRedirectUrl(c, redirectUrl);
    const host = c.req.header("host") ?? null;
    const err = c.req.query("error");
    if (err) {
      log.warn({ error: err, host }, "slack oauth callback denied at slack");
      return c.redirect(`${callbackWebOrigin}/?slack=denied`, 302);
    }

    const code = c.req.query("code");
    const state = c.req.query("state") ?? "";
    if (!code) {
      log.warn({ host }, "slack oauth callback missing code");
      return c.redirect(`${callbackWebOrigin}/?slack=error`, 302);
    }

    const decoded = verifyState(state, stateSecret);
    if (!decoded) {
      // State failed HMAC verification or aged past its 10-minute TTL — the
      // latter is what a user hits when they linger on Slack's consent screen
      // (e.g. waiting on workspace-admin approval) and then return. Bounce them
      // back to the app with a retryable error instead of dead-ending on a bare
      // JSON 400, and log it so connect drop-offs are diagnosable.
      log.warn({ host }, "slack oauth callback rejected: invalid or expired state");
      return c.redirect(`${callbackWebOrigin}/?slack=error`, 302);
    }
    const orgId = decoded.orgId;
    const projectId = decoded.projectId;
    if (
      decoded.userId &&
      !(await hasProjectManagerAccess({
        userId: decoded.userId,
        preferredOrgId: decoded.orgId,
        projectId: decoded.projectId,
      }))
    ) {
      return c.redirect(`${callbackWebOrigin}/?slack=error`, 302);
    }
    log.info(
      { org_id: orgId, project_id: projectId, host: c.req.header("host") ?? null },
      "slack oauth callback received",
    );

    const res = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: callbackRedirectUrl,
      }),
    });
    const data = (await res.json()) as SlackOAuthResponse;
    if (!data.ok || !data.access_token || !data.team?.id) {
      log.error({ error: data.error ?? "no_access_token" }, "oauth exchange failed");
      return c.redirect(`${callbackWebOrigin}/?slack=error`, 302);
    }

    await upsertInstallation({
      projectId,
      teamId: data.team.id,
      teamName: data.team.name ?? null,
      botUserId: data.bot_user_id ?? null,
      botAccessToken: data.access_token,
      scope: data.scope ?? null,
      installedByUserId: decoded.userId,
    });
    log.info(
      {
        org_id: orgId,
        project_id: projectId,
        team_id: data.team.id,
        team_name: data.team.name ?? null,
        installed_by: decoded.userId,
      },
      "slack installed",
    );

    // Re-auth of an installation that already routes to a channel: join it
    // now, so a bare reinstall (done to grant channels:join) repairs thread-
    // reply delivery without the user re-picking the channel. Best-effort —
    // a failure here must not derail the OAuth redirect.
    const installed = await findInstallation(projectId);
    if (installed?.channelId) {
      const joined = await joinSlackChannel(data.access_token, installed.channelId);
      log.info(
        {
          project_id: projectId,
          channel_id: installed.channelId,
          joined: joined.ok,
          ...(joined.ok ? {} : { join_error: joined.error }),
        },
        "slack channel join after install",
      );
    }
    void syncLoopsContactsForOrg({ orgId, appUrl: webOrigin }).catch((err) => {
      log.warn({ err, org_id: orgId }, "loops contact sync failed after slack connect");
    });

    // Skill-driven install: bounce the user back to /activate so they see a
    // consistent "you're connected" page tied to the agent flow they came
    // from. CLI/dashboard-driven install lands on the dashboard as before.
    if (decoded.userCode) {
      const flow = getDeviceFlow(decoded.userCode);
      const flowQuery = flow === "skill" ? "&flow=skill" : "";
      return c.redirect(
        `${callbackWebOrigin}/activate?code=${decoded.userCode}${flowQuery}&slack=done`,
        302,
      );
    }
    return c.redirect(`${callbackWebOrigin}/?slack=installed`, 302);
  });

  app.post("/slack/events", async (c) => {
    if (!signingSecret) return c.json({ error: "slack signing secret not configured" }, 503);

    const rawBody = await c.req.text();
    if (!verifySlackSignature(c, signingSecret, rawBody)) {
      log.warn({ path: "/slack/events" }, "slack signature verification failed");
      return c.json({ error: "invalid slack signature" }, 401);
    }

    const payload = JSON.parse(rawBody) as SlackEventEnvelope;
    if (payload.type === "url_verification" && typeof payload.challenge === "string") {
      return c.json({ challenge: payload.challenge });
    }
    if (payload.type !== "event_callback") return c.json({ ok: true });

    // Ack Slack immediately and process out of band: the handler does DB work
    // and an outbound chat.postMessage, which can exceed Slack's ~3s window and
    // trigger retries (= duplicate delivery). The handler is idempotent on the
    // event id, so the rare retry that still arrives is deduped.
    void handleSlackEventEnvelope(payload).catch((err) =>
      log.error(
        { err, event_type: payload.event?.type, event_id: payload.event_id },
        "slack event handler failed",
      ),
    );
    return c.json({ ok: true });
  });

  app.post("/slack/interactivity", async (c) => {
    if (!signingSecret) return c.json({ error: "slack signing secret not configured" }, 503);

    const rawBody = await c.req.text();
    if (!verifySlackSignature(c, signingSecret, rawBody)) {
      return c.json({ error: "invalid slack signature" }, 401);
    }

    const form = new URLSearchParams(rawBody);
    const payloadRaw = form.get("payload");
    if (!payloadRaw) return c.json({ ok: true });
    const payload = JSON.parse(payloadRaw) as SlackInteractivityPayload;

    try {
      if (payload.type === "block_actions") {
        await handleSlackBlockActions(payload);
      } else if (payload.type === "view_submission") {
        await handleSlackViewSubmission(payload);
      }
    } catch (err) {
      log.error({ err, type: payload.type }, "slack interactivity handler failed");
    }

    // view_submission has a strict ack contract: to close the modal, respond
    // HTTP 200 with an EMPTY body. Any non-empty body that isn't a recognized
    // `response_action` makes Slack surface "We had some trouble connecting.
    // Try again?" and leave the modal open — which is exactly what broke the
    // incident feedback modal's Send step (we were returning `{"ok":true}`).
    // block_actions has no such constraint (Slack ignores the ack body), so an
    // empty 200 is a valid ack there too — return one for every interactivity
    // type to stay on the safe side of the contract.
    return c.body(null, 200);
  });
}

// Block_actions arrive when someone clicks a non-URL button in a message.
// Recognized action_ids (all encoded by the worker's incidentBlocks builder
// or the sweep proposal posting):
//   - `rate_incident:<rating>:<incident-uuid>` → records a 👍/👎 rating, then
//     opens an optional detail modal (feedback_detail:<feedback-uuid>)
//   - `give_feedback:<incident-uuid>` → opens a feedback modal (legacy: still
//     handled for threads posted before the 👍/👎 buttons replaced it)
//   - `resolve_incident:<incident-uuid>` → "Problem resolved": incident
//     resolved, issues resolved (recurrence opens a new chained incident)
//   - `not_an_issue:<incident-uuid>` → incident resolved, issues silenced
//   - `unsilence_resolve:<incident-uuid>` → flips issues a closed-PR
//     resolution silenced back to resolved, so recurrences re-page
//   - `merge_pr:<incident-uuid>` → merges the incident's latest open agent PR
//   - `retry_investigation:<incident-uuid>` → retries only when the latest run
//     is still blocked on GitHub, making repeated clicks idempotent
async function handleSlackBlockActions(payload: SlackInteractivityPayload): Promise<void> {
  const action = payload.actions?.[0];
  if (!action) return;
  const actionId = action.action_id ?? "";

  if (actionId.startsWith("resolve_incident:")) {
    const incidentId = actionId.slice("resolve_incident:".length);
    if (incidentId) await handleSlackResolveIncident(incidentId, payload, "problem_resolved");
    return;
  }

  if (actionId.startsWith("not_an_issue:")) {
    const incidentId = actionId.slice("not_an_issue:".length);
    if (incidentId) await handleSlackResolveIncident(incidentId, payload, "not_an_issue");
    return;
  }

  if (actionId.startsWith("unsilence_resolve:")) {
    const incidentId = actionId.slice("unsilence_resolve:".length);
    if (incidentId) await handleSlackUnsilenceResolve(incidentId, payload);
    return;
  }

  if (actionId.startsWith("merge_pr:")) {
    const incidentId = actionId.slice("merge_pr:".length);
    if (incidentId) await handleSlackMergePr(incidentId, payload);
    return;
  }

  const retryIncidentId = parseRetryInvestigationAction(actionId);
  if (retryIncidentId) {
    await handleSlackRetryInvestigation(retryIncidentId, payload);
    return;
  }

  const rated = parseRateIncidentAction(actionId);
  if (rated) {
    await handleSlackRateIncident(rated.incidentId, rated.rating, payload);
    return;
  }

  if (actionId.startsWith("follow_up_confirm:")) {
    const feedbackId = actionId.slice("follow_up_confirm:".length);
    if (feedbackId) await handleFollowUpConfirm(feedbackId, payload);
    return;
  }

  if (actionId.startsWith("resolve_proposal_confirm:")) {
    const proposalId = actionId.slice("resolve_proposal_confirm:".length);
    if (proposalId) await handleProposalDecision(proposalId, "confirm", payload);
    return;
  }
  if (actionId.startsWith("resolve_proposal_dismiss:")) {
    const proposalId = actionId.slice("resolve_proposal_dismiss:".length);
    if (proposalId) await handleProposalDecision(proposalId, "dismiss", payload);
    return;
  }

  if (!actionId.startsWith("give_feedback:")) return;
  const incidentId = actionId.slice("give_feedback:".length);
  if (!incidentId) return;

  const incident = await db.query.incidents.findFirst({
    where: eq(schema.incidents.id, incidentId),
  });
  if (!incident) {
    log.warn({ incidentId }, "give_feedback click for unknown incident");
    return;
  }
  const installation = await installationForIncident({
    pinnedId: incident.slackInstallationId,
    teamId: payload.team?.id ?? "",
  });
  if (!installation) {
    log.warn({ team_id: payload.team?.id, incidentId }, "no installation for feedback modal");
    return;
  }

  const view = {
    type: "modal",
    callback_id: `feedback_modal:${incidentId}`,
    title: { type: "plain_text", text: "Send feedback" },
    submit: { type: "plain_text", text: "Send" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Feedback on incident:*\n_${truncateModalText(incident.title)}_\nGoes straight to the Superlog team.`,
        },
      },
      {
        type: "input",
        block_id: "feedback_body",
        label: { type: "plain_text", text: "What's on your mind?" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          multiline: true,
          max_length: 3000,
          placeholder: {
            type: "plain_text",
            text: "What worked, what didn't, what's missing…",
          },
        },
      },
    ],
  };

  const res = await fetch("https://slack.com/api/views.open", {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${installation.botAccessToken}`,
    },
    body: JSON.stringify({ trigger_id: payload.trigger_id, view }),
  });
  const data = (await res.json()) as { ok: boolean; error?: string };
  if (!data.ok) {
    log.warn({ error: data.error, incidentId }, "views.open failed for feedback modal");
  }
}

// Decode a `rate_incident:<rating>:<incidentId>` action_id from the 👍/👎
// buttons on the incident thread. Incident ids are UUIDs (no colons), so a
// single split after the rating is unambiguous.
export function parseRateIncidentAction(
  actionId: string,
): { rating: schema.FeedbackRating; incidentId: string } | null {
  const prefix = "rate_incident:";
  if (!actionId.startsWith(prefix)) return null;
  const rest = actionId.slice(prefix.length);
  const sep = rest.indexOf(":");
  if (sep <= 0) return null;
  const rating = rest.slice(0, sep);
  const incidentId = rest.slice(sep + 1);
  if (!incidentId) return null;
  if (rating !== "helpful" && rating !== "unhelpful") return null;
  return { rating, incidentId };
}

export function parseRetryInvestigationAction(actionId: string): string | null {
  const prefix = "retry_investigation:";
  if (!actionId.startsWith(prefix)) return null;
  return actionId.slice(prefix.length) || null;
}

async function handleSlackRetryInvestigation(
  incidentId: string,
  payload: SlackInteractivityPayload,
): Promise<void> {
  const result = await retryBlockedAgentRun(db, { incidentId });
  if (result.outcome !== "retried") {
    log.info(
      { incident_id: incidentId, outcome: result.outcome },
      "Slack investigation retry did not enqueue a successor",
    );
    return;
  }

  const incident = await db.query.incidents.findFirst({
    where: eq(schema.incidents.id, incidentId),
  });
  if (!incident?.slackChannelId || !incident.slackThreadTs) return;
  const installation = await installationForIncident({
    pinnedId: incident.slackInstallationId,
    teamId: payload.team?.id ?? "",
  });
  if (!installation) return;
  const slackUserId = payload.user?.id ?? null;
  const attribution = slackUserId ? ` by <@${slackUserId}>` : "";
  await postSlackThreadReply({
    botToken: installation.botAccessToken,
    channel: incident.slackChannelId,
    threadTs: incident.slackThreadTs,
    text: `:arrows_counterclockwise: Investigation retry requested${attribution}.`,
  });
}

// Synthesized `feedback.body` for a bare rating click. `body` is NOT NULL, and
// the team notifier + admin inbox render it, so a thumbs-only click still reads
// sensibly. Overwritten by the typed text if the user fills the detail modal.
// Plain text (no emoji) — the notifier prepends its own 👍/👎 rating badge from
// `feedback.rating`, and the admin inbox renders a separate chip, so baking the
// emoji in here would double it up (">👍 👍 Marked helpful").
export function ratingFeedbackBody(rating: schema.FeedbackRating): string {
  return rating === "helpful" ? "Marked helpful" : "Marked not helpful";
}

// One-liner shown on the incident timeline (incident_events.summary) for a
// rating click. The 👍/👎 carries the signal — LifecycleEntry renders the
// summary verbatim with no per-kind styling.
export function ratingTimelineSummary(rating: schema.FeedbackRating): string {
  return rating === "helpful"
    ? "👍 Marked the investigation helpful"
    : "👎 Marked the investigation not helpful";
}

// A 👍/👎 click records the rating immediately (so the signal survives even if
// the user dismisses the modal), then opens an OPTIONAL detail modal. The modal
// submit attaches free-form text to this same feedback row.
async function handleSlackRateIncident(
  incidentId: string,
  rating: schema.FeedbackRating,
  payload: SlackInteractivityPayload,
): Promise<void> {
  const incident = await db.query.incidents.findFirst({
    where: eq(schema.incidents.id, incidentId),
  });
  if (!incident) {
    log.warn({ incidentId }, "rate_incident click for unknown incident");
    return;
  }
  const project = await db.query.projects.findFirst({
    where: eq(schema.projects.id, incident.projectId),
  });

  // Claim this click first, before any side effect. `handleSlackBlockActions`
  // runs to completion before we ack, and this handler makes a `views.open`
  // round-trip — enough to blow Slack's 3s window and trigger a retry. Keying
  // the timeline event on the click's own `action_ts` (stable across retries)
  // rather than the freshly-minted feedback row id makes the whole handler
  // idempotent: a retry loses the insert race and returns here, so it can't
  // double-record the feedback row or re-open the modal. A genuine second
  // rating carries a new action_ts, so it's not suppressed. The `?? Date.now()`
  // fallback (action_ts should always be present for block_actions) degrades to
  // the old always-unique behavior rather than collapsing distinct clicks.
  const actionTs = payload.actions?.[0]?.action_ts ?? String(Date.now());
  const dedupeKey = `feedback-rating:${incidentId}:${payload.user?.id ?? "anon"}:${rating}:${actionTs}`;
  const [claimed] = await db
    .insert(schema.incidentEvents)
    .values({
      incidentId,
      kind: "feedback_rating",
      summary: ratingTimelineSummary(rating),
      detail: {
        rating,
        source: "slack",
        slackUserId: payload.user?.id ?? null,
      },
      dedupeKey,
      processedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: schema.incidentEvents.id });
  // Lost the race to a retry (or a stray duplicate) — the rating is already
  // recorded and the modal already opened. Don't do it again.
  if (!claimed) return;

  const row = await recordFeedback({
    kind: "incident",
    refId: incidentId,
    refRepo: null,
    source: "slack_rating",
    body: ratingFeedbackBody(rating),
    rating,
    authorUserId: null,
    authorExternal: {
      slackUserId: payload.user?.id,
      slackTeamId: payload.team?.id,
    },
    orgId: project?.orgId ?? null,
    projectId: project?.id ?? null,
    // Defer the follow-up offer to the detail modal — a bare thumb shouldn't
    // spawn a "run follow-up" prompt with no context attached.
    offerFollowUp: false,
  });
  if (!row) return;

  const installation = await installationForIncident({
    pinnedId: incident.slackInstallationId,
    teamId: payload.team?.id ?? "",
  });
  if (!installation) return;

  const prompt =
    rating === "helpful"
      ? "Glad it helped. Anything that made it useful — or that we could do better?"
      : "Thanks — noted. What was off or missing? (optional)";
  const view = {
    type: "modal",
    callback_id: `feedback_detail:${row.id}`,
    title: { type: "plain_text", text: "Add detail" },
    submit: { type: "plain_text", text: "Send" },
    close: { type: "plain_text", text: "Skip" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${rating === "helpful" ? "👍 Helpful" : "👎 Not helpful"}* — _${truncateModalText(
            incident.title,
          )}_\nRecorded. Add detail below or just skip.`,
        },
      },
      {
        type: "input",
        block_id: "feedback_body",
        optional: true,
        label: { type: "plain_text", text: prompt },
        element: {
          type: "plain_text_input",
          action_id: "value",
          multiline: true,
          max_length: 3000,
          placeholder: {
            type: "plain_text",
            text: "What worked, what didn't, what's missing…",
          },
        },
      },
    ],
  };

  const res = await fetch("https://slack.com/api/views.open", {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${installation.botAccessToken}`,
    },
    body: JSON.stringify({ trigger_id: payload.trigger_id, view }),
  });
  const data = (await res.json()) as { ok: boolean; error?: string };
  if (!data.ok) {
    log.warn({ error: data.error, incidentId }, "views.open failed for rating detail modal");
  }
}

// Handle a `resolve_incident:<incidentId>` block_actions click. The Slack
// button has a confirm dialog client-side, so by the time we see this the
// user has already double-confirmed. Path:
//   1. Look up the incident + the Slack installation for the team
//   2. Call resolveIncident() — idempotent against concurrent clicks
//   3. Post a threaded "Resolved by @user" reply for an audit trail visible
//      in Slack (the row in `incidents.resolved_*` is the structured truth)
//   4. Update the root message in-place so the status badge reflects closure
//      and the Resolve button disappears
//
// All Slack side effects are best-effort: a chat.postMessage / chat.update
// failure (channel archived, bot kicked, etc.) doesn't unwind the DB resolve.
// The user can always reopen via recurrence; what we don't want is the DB
// saying open while Slack thinks resolved (or vice-versa) on a transient
// failure.
async function handleSlackResolveIncident(
  incidentId: string,
  payload: SlackInteractivityPayload,
  resolution: "problem_resolved" | "not_an_issue",
): Promise<void> {
  const incident = await db.query.incidents.findFirst({
    where: eq(schema.incidents.id, incidentId),
  });
  if (!incident) {
    log.warn({ incidentId }, "resolve_incident click for unknown incident");
    return;
  }
  if (resolveSlackResolveClickDisposition(incident.status) === "refresh_side_effects") {
    log.info(
      { incidentId, status: incident.status },
      "resolve_incident click on already-closed incident, refreshing side effects",
    );
    const resolutionProof = await loadCurrentIncidentResolutionProof({ incidentId });
    if (resolutionProof) {
      await runSlackResolvedIncidentSideEffects(incidentId, resolutionProof);
    }
    return;
  }

  const slackUserId = payload.user?.id ?? null;
  const slackUserName = payload.user?.name ?? null;
  const attribution = slackUserId ? `<@${slackUserId}>` : (slackUserName ?? "a teammate");

  const { resolved, resolutionProof } = await resolveIncidentWithProof({
    incidentId,
    kind: "slack_manual",
    reasonCode: resolution,
    reasonText:
      resolution === "not_an_issue"
        ? `Marked not-an-issue from Slack by ${slackUserName ?? slackUserId ?? "unknown user"}.`
        : `Resolved from Slack by ${slackUserName ?? slackUserId ?? "unknown user"}.`,
    resolvedBySlackUserId: slackUserId,
    issueOutcome: resolution === "not_an_issue" ? { kind: "silence" } : { kind: "resolve" },
    // No investigation context here — the incident may or may not have one;
    // the resolved_* columns on incidents are the audit-of-record for manual
    // resolves. Skip the investigation event to avoid coupling to a possibly-
    // unrelated latest investigation.
  });
  if (resolutionProof) {
    await runSlackResolvedIncidentSideEffects(incidentId, resolutionProof);
  }

  if (!resolved) {
    log.info({ incidentId }, "resolve_incident click lost race with concurrent close");
    return;
  }

  const installation = await installationForIncident({
    pinnedId: incident.slackInstallationId,
    teamId: payload.team?.id ?? "",
  });
  if (!installation) {
    log.warn({ team_id: payload.team?.id, incidentId }, "no installation to post resolve reply");
    return;
  }
  if (incident.slackChannelId && incident.slackThreadTs) {
    await postSlackThreadReply({
      botToken: installation.botAccessToken,
      channel: incident.slackChannelId,
      threadTs: incident.slackThreadTs,
      text:
        resolution === "not_an_issue"
          ? `:no_bell: Marked not-an-issue by ${attribution}. The linked issues are silenced; future occurrences will not open incidents.`
          : `:white_check_mark: Incident resolved by ${attribution}. If the underlying error reappears, a new incident will open with this investigation's findings attached.`,
    });
  }
}

// Handle an `unsilence_resolve:<incidentId>` click: the closed-PR resolution
// silenced the incident's issues by default; this flips them back to
// `resolved` so the next occurrence opens a chained incident, then refreshes
// the root message (which re-renders as plain resolved once nothing is
// silenced). Idempotent — a repeat click finds nothing silenced and only
// refreshes.
async function handleSlackUnsilenceResolve(
  incidentId: string,
  payload: SlackInteractivityPayload,
): Promise<void> {
  const incident = await db.query.incidents.findFirst({
    where: eq(schema.incidents.id, incidentId),
  });
  if (!incident) {
    log.warn({ incidentId }, "unsilence_resolve click for unknown incident");
    return;
  }
  const slackUserId = payload.user?.id ?? null;
  const slackUserName = payload.user?.name ?? null;
  const attribution = slackUserId ? `<@${slackUserId}>` : (slackUserName ?? "a teammate");

  const { unsilencedIssueCount } = await unsilenceIncidentIssues({
    incidentId,
    resolvedBySlackUserId: slackUserId ?? undefined,
  });

  const resolutionProof = await loadCurrentIncidentResolutionProof({ incidentId });
  if (resolutionProof) {
    await runSlackResolvedIncidentSideEffects(incidentId, resolutionProof);
  }
  if (unsilencedIssueCount === 0) {
    log.info({ incidentId }, "unsilence_resolve click found no silenced issues");
    return;
  }

  const installation = await installationForIncident({
    pinnedId: incident.slackInstallationId,
    teamId: payload.team?.id ?? "",
  });
  if (!installation) {
    log.warn({ team_id: payload.team?.id, incidentId }, "no installation to post unsilence reply");
    return;
  }
  if (incident.slackChannelId && incident.slackThreadTs) {
    await postSlackThreadReply({
      botToken: installation.botAccessToken,
      channel: incident.slackChannelId,
      threadTs: incident.slackThreadTs,
      text: `:bell: ${attribution} chose to keep tracking these errors. The issues are resolved instead of silenced — if the error recurs, a new incident will open.`,
    });
  }
}

// Handle a `merge_pr:<incidentId>` click: merge the incident's most recent
// open agent PR (squash) and resolve the incident as agent_pr_merged. The
// button carries a client-side confirm dialog; anyone in the channel can
// click it, matching the resolve buttons.
async function handleSlackMergePr(
  incidentId: string,
  payload: SlackInteractivityPayload,
): Promise<void> {
  const incident = await db.query.incidents.findFirst({
    where: eq(schema.incidents.id, incidentId),
  });
  if (!incident) {
    log.warn({ incidentId }, "merge_pr click for unknown incident");
    return;
  }
  const pr = await db.query.agentPullRequests.findFirst({
    where: and(
      eq(schema.agentPullRequests.incidentId, incidentId),
      eq(schema.agentPullRequests.state, "open"),
    ),
    orderBy: [desc(schema.agentPullRequests.createdAt)],
  });
  const slackUserId = payload.user?.id ?? null;
  const slackUserName = payload.user?.name ?? null;
  const attribution = slackUserId ? `<@${slackUserId}>` : (slackUserName ?? "a teammate");

  const installation = await installationForIncident({
    pinnedId: incident.slackInstallationId,
    teamId: payload.team?.id ?? "",
  });
  const reply = async (text: string) => {
    if (!installation || !incident.slackChannelId || !incident.slackThreadTs) return;
    await postSlackThreadReply({
      botToken: installation.botAccessToken,
      channel: incident.slackChannelId,
      threadTs: incident.slackThreadTs,
      text,
    });
  };

  if (!pr) {
    log.info({ incidentId }, "merge_pr click but no open agent PR");
    await reply(":warning: No open agent PR to merge for this incident.");
    return;
  }

  try {
    const outcome = await mergeAgentPullRequestAndResolveIncident({
      pr,
      method: "squash",
      source: `slack:${slackUserId ?? slackUserName ?? "unknown"}`,
    });
    if (!outcome.ok) {
      await reply(
        outcome.reason === "pr_not_open"
          ? `:warning: PR #${pr.prNumber} is already ${pr.state}.`
          : ":warning: Could not merge — the GitHub installation is unavailable.",
      );
      return;
    }
    const suffix =
      outcome.incidentDisposition === "resolved"
        ? "incident resolved."
        : outcome.incidentDisposition === "already_resolved"
          ? "incident was already resolved."
          : outcome.incidentDisposition === "continued_in_session"
            ? "investigation continued with the merge event."
            : "waiting on the remaining pull requests.";
    await reply(
      `:twisted_rightwards_arrows: PR #${pr.prNumber} merged by ${attribution} — ${suffix}`,
    );
  } catch (err) {
    log.warn(
      { incidentId, pr_id: pr.id, err: err instanceof Error ? err.message : String(err) },
      "merge_pr click failed",
    );
    await reply(
      `:warning: Merging PR #${pr.prNumber} failed — check branch protections or merge it on GitHub.`,
    );
  }
}

async function runSlackResolvedIncidentSideEffects(
  incidentId: string,
  resolutionProof: IncidentResolutionProof,
): Promise<void> {
  await runResolvedIncidentSideEffectsForIncident({
    incidentId,
    resolutionProof,
    closePullRequest: (pr) =>
      closeAgentPullRequestOnGithub({
        installationId: pr.githubInstallationId,
        fallbackInstallationIds: pr.fallbackGithubInstallationIds,
        repoFullName: pr.repoFullName,
        prNumber: pr.prNumber,
        prNodeId: pr.prNodeId,
      }),
    reopenPullRequest: (pr) =>
      reopenAgentPullRequestOnGithub({
        installationId: pr.githubInstallationId,
        fallbackInstallationIds: pr.fallbackGithubInstallationIds,
        repoFullName: pr.repoFullName,
        prNumber: pr.prNumber,
        prNodeId: pr.prNodeId,
      }),
  });
}

// Confirm / Dismiss buttons on a sweep-agent resolution proposal posted
// into the incident's Slack thread. The proposal row is the audit record;
// confirming additionally closes the incident via resolveIncident().
// We always edit the proposal message in place so the buttons disappear
// and the surfaced text reflects the decision — clicking the same button
// twice (or the other after a decision) becomes a visible no-op.
async function handleProposalDecision(
  proposalId: string,
  decision: "confirm" | "dismiss",
  payload: SlackInteractivityPayload,
): Promise<void> {
  const slackUserId = payload.user?.id ?? null;
  const slackUserName = payload.user?.name ?? null;
  const actor = { slackUserId, displayName: slackUserName };
  const result =
    decision === "confirm"
      ? await confirmResolutionProposal({ proposalId, actor })
      : await dismissResolutionProposal({ proposalId, actor });
  if (!result.ok) {
    // Decision rejected (race with another click, unknown id, already
    // decided). Stop here so we don't overwrite the Slack message with a
    // status that doesn't match the actual proposal state.
    log.info(
      { proposalId, decision, reason: result.reason },
      "proposal decision rejected (race or unknown id)",
    );
    return;
  }
  if (decision === "confirm" && result.incidentId && result.resolutionProof) {
    await runResolvedIncidentSideEffectsForIncident({
      incidentId: result.incidentId,
      resolutionProof: result.resolutionProof,
      closePullRequest: (pr) =>
        closeAgentPullRequestOnGithub({
          installationId: pr.githubInstallationId,
          fallbackInstallationIds: pr.fallbackGithubInstallationIds,
          repoFullName: pr.repoFullName,
          prNumber: pr.prNumber,
          prNodeId: pr.prNodeId,
        }),
      reopenPullRequest: (pr) =>
        reopenAgentPullRequestOnGithub({
          installationId: pr.githubInstallationId,
          fallbackInstallationIds: pr.fallbackGithubInstallationIds,
          repoFullName: pr.repoFullName,
          prNumber: pr.prNumber,
          prNodeId: pr.prNodeId,
        }),
    });
  }
  // Re-render the proposal message: drop the buttons, swap in a status line
  // crediting the deciding user. The message lives in the incident thread,
  // so this update is non-destructive — the original incident root
  // message and earlier thread activity are untouched.
  const proposal = await db.query.incidentResolutionProposals.findFirst({
    where: eq(schema.incidentResolutionProposals.id, proposalId),
  });
  if (!proposal?.slackChannelId || !proposal.slackMessageTs) return;

  const installation = await installationForIncident({
    pinnedId: proposal.slackInstallationId,
    teamId: payload.team?.id ?? "",
  });
  if (!installation) return;

  const attribution = slackUserId ? `<@${slackUserId}>` : (slackUserName ?? "a teammate");
  const headerEmoji = decision === "confirm" ? ":white_check_mark:" : ":x:";
  const headerText =
    decision === "confirm"
      ? `${headerEmoji} *Resolution confirmed* by ${attribution}`
      : `${headerEmoji} *Proposal dismissed* by ${attribution}`;
  const footer =
    decision === "confirm"
      ? "Incident closed. If the underlying error recurs it will reopen automatically."
      : "Incident left open. We won't propose resolution again for 24h.";

  const updatedBlocks: unknown[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          headerText,
          proposal.proposedReasonText,
          `_Reason: \`${proposal.proposedReasonCode}\`_`,
          footer,
        ].join("\n"),
      },
    },
  ];
  try {
    await fetch("https://slack.com/api/chat.update", {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${installation.botAccessToken}`,
      },
      body: JSON.stringify({
        channel: proposal.slackChannelId,
        ts: proposal.slackMessageTs,
        text: `${headerText} — ${proposal.proposedReasonText}`,
        blocks: updatedBlocks,
      }),
    });
  } catch (err) {
    log.warn({ err, proposalId }, "proposal message re-render failed");
  }
}

// Handle a `follow_up_confirm:<feedbackId>` click from the offer posted by
// offerFollowUpForFeedback. Enqueues a confirm-gated follow-up run (the
// confirmed flag bypasses the project's auto-follow-up gate, not the caps)
// and replies in-thread with the outcome.
async function handleFollowUpConfirm(
  feedbackId: string,
  payload: SlackInteractivityPayload,
): Promise<void> {
  const feedback = await db.query.feedback
    .findFirst({ where: eq(schema.feedback.id, feedbackId) })
    .catch(() => null);
  if (!feedback) {
    log.warn({ feedbackId }, "follow_up_confirm click for unknown feedback");
    return;
  }
  const incidentId = await resolveFeedbackIncidentId(feedback);
  if (!incidentId) {
    log.warn({ feedbackId }, "follow_up_confirm feedback does not bind to an incident");
    return;
  }
  const incident = await db.query.incidents.findFirst({
    where: eq(schema.incidents.id, incidentId),
  });
  if (!incident) return;

  const result = await requestFollowUpAgentRun(db, {
    incidentId,
    trigger: "feedback",
    confirmed: true,
    interaction: {
      channel: "feedback",
      author:
        feedback.authorExternal?.githubLogin ??
        feedback.authorExternal?.slackUserId ??
        feedback.authorUserId,
      text: feedback.body,
      occurredAt: (feedback.createdAt ?? new Date()).toISOString(),
    },
  });

  const installation = await installationForIncident({
    pinnedId: incident.slackInstallationId,
    teamId: payload.team?.id ?? "",
  });
  if (!installation || !incident.slackChannelId || !incident.slackThreadTs) return;
  const clickedBy = payload.user?.id ? `<@${payload.user.id}>` : "someone";
  const text =
    result.outcome === "skipped"
      ? result.reason === "follow_up_cap_reached"
        ? ":no_entry: Can't run another follow-up — this incident reached its follow-up limit."
        : result.reason === "run_active"
          ? ":hourglass: An investigation is already running for this incident; the feedback was recorded."
          : `:no_entry: Follow-up not started (${result.reason.replace(/_/g, " ")}).`
      : `:mag: Follow-up investigation queued by ${clickedBy} — the agent will take this feedback into account.`;
  await postSlackThreadReply({
    botToken: installation.botAccessToken,
    channel: incident.slackChannelId,
    threadTs: incident.slackThreadTs,
    text,
  });
}

async function postSlackThreadReply(opts: {
  botToken: string;
  channel: string;
  // Null posts to the channel root (DM conversations have no thread anchor).
  threadTs: string | null;
  text: string;
}): Promise<void> {
  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${opts.botToken}`,
      },
      body: JSON.stringify({
        channel: opts.channel,
        thread_ts: opts.threadTs ?? undefined,
        text: opts.text,
      }),
    });
    const data = (await res.json()) as { ok: boolean; error?: string };
    if (!data.ok) {
      log.warn(
        { error: data.error, channel: opts.channel, thread_ts: opts.threadTs },
        "thread reply post failed",
      );
    }
  } catch (err) {
    log.warn({ err, channel: opts.channel }, "chat.postMessage threw");
  }
}

async function handleSlackViewSubmission(payload: SlackInteractivityPayload): Promise<void> {
  const callbackId = payload.view?.callback_id ?? "";

  // Optional detail typed after a 👍/👎 click — the rating row already exists,
  // so attach the text to it (input is `optional`, so an empty submit is a
  // valid no-op skip).
  if (callbackId.startsWith("feedback_detail:")) {
    const feedbackId = callbackId.slice("feedback_detail:".length);
    const detail = payload.view?.state?.values?.feedback_body?.value?.value?.trim() ?? "";
    if (feedbackId && detail) await attachFeedbackDetail(feedbackId, detail);
    return;
  }

  if (!callbackId.startsWith("feedback_modal:")) return;
  const incidentId = callbackId.slice("feedback_modal:".length);
  if (!incidentId) return;
  const body = payload.view?.state?.values?.feedback_body?.value?.value?.trim() ?? "";
  if (!body) return;

  const incident = await db.query.incidents.findFirst({
    where: eq(schema.incidents.id, incidentId),
  });
  const project = incident
    ? await db.query.projects.findFirst({
        where: eq(schema.projects.id, incident.projectId),
      })
    : null;

  await recordFeedback({
    kind: "incident",
    refId: incidentId,
    refRepo: null,
    source: "slack_button",
    body,
    authorUserId: null,
    authorExternal: {
      slackUserId: payload.user?.id,
      slackTeamId: payload.team?.id,
    },
    orgId: project?.orgId ?? null,
    projectId: project?.id ?? null,
  });
}

async function findInstallationForTeam(teamId: string) {
  if (!teamId) return null;
  return db.query.slackInstallations.findFirst({
    where: and(
      eq(schema.slackInstallations.teamId, teamId),
      isNull(schema.slackInstallations.revokedAt),
    ),
    // When a team owns multiple non-revoked rows (the same workspace installed
    // into several projects) Slack keeps only the most-recently-minted bot
    // token live, so order by token-refresh recency — `installedAt`, which is
    // set on every (re)auth, NOT `createdAt`, which the in-place token refresh
    // leaves stale. Legacy rows predating `installedAt` are NULL, so fall back
    // to `createdAt` for them via coalesce rather than letting NULLs sort last.
    // Still best-effort: for incident-scoped actions prefer
    // installationForIncident, which uses the exact pinned installation. This
    // team lookup is only the legacy/unpinned fallback.
    orderBy: desc(
      sql`coalesce(${schema.slackInstallations.installedAt}, ${schema.slackInstallations.createdAt})`,
    ),
  });
}

// Apply the installation-selection precedence for incident-scoped Slack
// interactions: the installation pinned to the incident/proposal — the exact
// workspace + bot token that posted the thread — wins over any team-wide match.
//
// Why this matters: a workspace can be installed into more than one project,
// and `upsertInstallation` keys rows by project (unique on project_id+team_id),
// so one Slack team can own several non-revoked `slack_installations` rows.
// Slack issues a fresh bot token on each (re)install and invalidates the prior
// token, so only one of those rows holds a live token at a time. A team-wide
// `findFirst` can therefore return a stale row whose token fails every Slack
// API call with `invalid_auth` — which is exactly what silently broke the
// incident feedback modal (views.open -> invalid_auth, so the modal never
// opened and the click looked like a no-op). The pin is exact, so honour it
// first; the team match is only a fallback for legacy rows written before the
// pin existed.
export function preferPinnedInstallation<T>(
  pinned: T | null | undefined,
  teamFallback: T | null | undefined,
): T | null {
  return pinned ?? teamFallback ?? null;
}

// Resolve the Slack installation to act through for an incident or proposal,
// preferring its pinned installation id (see preferPinnedInstallation). The
// team lookup only runs when there is no usable pin.
async function installationForIncident(opts: { pinnedId: string | null; teamId: string }) {
  const pinned = opts.pinnedId
    ? await db.query.slackInstallations.findFirst({
        where: and(
          eq(schema.slackInstallations.id, opts.pinnedId),
          isNull(schema.slackInstallations.revokedAt),
        ),
      })
    : null;
  return preferPinnedInstallation(
    pinned,
    pinned ? null : await findInstallationForTeam(opts.teamId),
  );
}

function truncateModalText(text: string): string {
  return text.length > 200 ? `${text.slice(0, 197)}…` : text;
}

// biome-ignore lint/suspicious/noExplicitAny: Hono Variables invariance.
export function mountSlackAuthed(app: Hono<any>): void {
  const clientId = process.env.SLACK_CLIENT_ID;
  const redirectUrl =
    process.env.SLACK_OAUTH_REDIRECT_URL ?? "http://localhost:4100/slack/oauth/callback";
  const stateSecret = process.env.STATE_SIGNING_SECRET;

  app.get("/api/projects/:projectId/slack/installation", async (c) => {
    const projectId = c.req.param("projectId");
    await requireProjectAccess(c, projectId);
    const row = await findInstallation(projectId);
    if (!row) return c.json({ installed: false });
    return c.json({
      installed: true,
      teamId: row.teamId,
      teamName: row.teamName,
    });
  });

  app.post("/api/projects/:projectId/slack/install-url", async (c) => {
    if (!clientId || !stateSecret) {
      return c.json({ error: "slack not configured" }, 503);
    }
    const projectId = c.req.param("projectId");
    const ctx = await requireProjectManager(c, projectId);
    const callbackRedirectUrl = resolveSlackRedirectUrl(c, redirectUrl);
    const state = signState({ orgId: ctx.orgId, projectId, userId: ctx.userId }, stateSecret);
    const url = new URL("https://slack.com/oauth/v2/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("scope", SCOPES);
    url.searchParams.set("redirect_uri", callbackRedirectUrl);
    url.searchParams.set("state", state);
    log.info(
      { org_id: ctx.orgId, project_id: projectId, redirect_uri: callbackRedirectUrl },
      "slack install url created",
    );
    return c.json({ url: url.toString() });
  });

  app.post("/api/projects/:projectId/slack/uninstall", async (c) => {
    const projectId = c.req.param("projectId");
    await requireProjectManager(c, projectId);
    const row = await findInstallation(projectId);
    if (!row) return c.json({ ok: true });

    try {
      await fetch("https://slack.com/api/auth.revoke", {
        method: "POST",
        headers: { authorization: `Bearer ${row.botAccessToken}` },
      });
    } catch (e) {
      log.warn({ err: e }, "auth.revoke failed");
    }

    await db
      .update(schema.slackInstallations)
      .set({ revokedAt: new Date() })
      .where(eq(schema.slackInstallations.id, row.id));
    return c.json({ ok: true });
  });

  app.get("/api/projects/:projectId/slack/channels", async (c) => {
    const projectId = c.req.param("projectId");
    await requireProjectAccess(c, projectId);
    const row = await findInstallation(projectId);
    if (!row) return c.json({ error: "slack not installed" }, 404);

    const result = await listSlackChannels(row.botAccessToken);
    if (!result.ok) {
      log.warn({ team_id: row.teamId, error: result.error }, "slack conversations.list failed");
      if (isRevokedSlackAuthError(result.error)) {
        await db
          .update(schema.slackInstallations)
          .set({ revokedAt: new Date() })
          .where(eq(schema.slackInstallations.id, row.id));
      }
      return c.json({ error: result.error }, 502);
    }
    return c.json({ channels: result.channels });
  });

  app.get("/api/slack/installation", async (c) => {
    const ctx = await resolveUserOrg(c);
    if (!ctx) return c.json({ installed: false });
    const row = await findInstallation(ctx.projectId);
    if (!row) return c.json({ installed: false });
    return c.json({
      installed: true,
      teamId: row.teamId,
      teamName: row.teamName,
    });
  });

  app.post("/api/slack/install-url", async (c) => {
    if (!clientId || !stateSecret) {
      return c.json({ error: "slack not configured" }, 503);
    }
    const callbackRedirectUrl = resolveSlackRedirectUrl(c, redirectUrl);
    const ctx = await resolveUserOrgManager(c);
    if (!ctx) return c.json({ error: "no org for user" }, 404);

    const state = signState(
      { orgId: ctx.orgId, projectId: ctx.projectId, userId: ctx.userId },
      stateSecret,
    );
    const url = new URL("https://slack.com/oauth/v2/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("scope", SCOPES);
    url.searchParams.set("redirect_uri", callbackRedirectUrl);
    url.searchParams.set("state", state);
    log.info(
      { org_id: ctx.orgId, project_id: ctx.projectId, redirect_uri: callbackRedirectUrl },
      "slack install url created",
    );
    return c.json({ url: url.toString() });
  });

  app.post("/api/slack/uninstall", async (c) => {
    const ctx = await resolveUserOrgManager(c);
    if (!ctx) return c.json({ error: "no org for user" }, 404);
    const row = await findInstallation(ctx.projectId);
    if (!row) return c.json({ ok: true });

    // Best-effort remote revoke; don't block on failure.
    try {
      await fetch("https://slack.com/api/auth.revoke", {
        method: "POST",
        headers: { authorization: `Bearer ${row.botAccessToken}` },
      });
    } catch (e) {
      log.warn({ err: e }, "auth.revoke failed");
    }

    await db
      .update(schema.slackInstallations)
      .set({ revokedAt: new Date() })
      .where(eq(schema.slackInstallations.id, row.id));
    return c.json({ ok: true });
  });

  app.get("/api/slack/channels", async (c) => {
    const ctx = await resolveUserOrg(c);
    if (!ctx) return c.json({ error: "no org for user" }, 404);
    const row = await findInstallation(ctx.projectId);
    if (!row) return c.json({ error: "slack not installed" }, 404);

    const result = await listSlackChannels(row.botAccessToken);
    if (!result.ok) {
      log.warn({ team_id: row.teamId, error: result.error }, "slack conversations.list failed");
      if (isRevokedSlackAuthError(result.error)) {
        await db
          .update(schema.slackInstallations)
          .set({ revokedAt: new Date() })
          .where(eq(schema.slackInstallations.id, row.id));
      }
      return c.json({ error: result.error }, 502);
    }
    return c.json({ channels: result.channels });
  });

  app.get("/api/projects/:projectId/slack-route", async (c) => {
    const projectId = c.req.param("projectId");
    await requireProjectAccess(c, projectId);
    const install = await findInstallation(projectId);
    if (!install || !install.channelId) return c.json({ configured: false });
    return c.json({
      configured: true,
      channelId: install.channelId,
      channelName: install.channelName,
    });
  });

  app.put("/api/projects/:projectId/slack-route", async (c) => {
    const projectId = c.req.param("projectId");
    await requireProjectManager(c, projectId);
    const install = await findInstallation(projectId);
    if (!install) return c.json({ error: "slack not installed" }, 400);

    const body = (await c.req.json().catch(() => ({}))) as {
      channelId?: unknown;
      channelName?: unknown;
    };
    const channelId = typeof body.channelId === "string" ? body.channelId : "";
    const channelName = typeof body.channelName === "string" ? body.channelName : null;
    if (!channelId) return c.json({ error: "channelId required" }, 400);

    await db
      .update(schema.slackInstallations)
      .set({ channelId, channelName })
      .where(eq(schema.slackInstallations.id, install.id));

    // Join the routed channel so thread replies flow back through the Events
    // API (posting alone works unjoined via chat:write.public, receiving does
    // not). Best-effort: private channels and pre-channels:join installs
    // can't self-join — surface that so the UI can suggest an /invite.
    const joined = await joinSlackChannel(install.botAccessToken, channelId);
    if (!joined.ok) {
      log.info(
        { project_id: projectId, channel_id: channelId, join_error: joined.error },
        "slack channel join on route change failed",
      );
    }
    return c.json({ ok: true, channelId, channelName, botJoined: joined.ok });
  });

  app.delete("/api/projects/:projectId/slack-route", async (c) => {
    const projectId = c.req.param("projectId");
    await requireProjectManager(c, projectId);
    const install = await findInstallation(projectId);
    if (install) {
      await db
        .update(schema.slackInstallations)
        .set({ channelId: null, channelName: null })
        .where(eq(schema.slackInstallations.id, install.id));
    }
    return c.json({ ok: true });
  });

  app.get("/api/projects/:projectId/slack-chat-default", async (c) => {
    const projectId = c.req.param("projectId");
    await requireProjectAccess(c, projectId);
    const install = await findInstallation(projectId);
    if (!install) return c.json({ installed: false, isDefaultChatProject: false });
    return c.json({ installed: true, isDefaultChatProject: install.isDefaultChatProject });
  });

  // Mark this project as the workspace's default for Q&A chats (bot mentions
  // outside any project's routed channel). One default per workspace: setting
  // it clears the flag on the team's other installations first, matching the
  // partial unique index.
  app.put("/api/projects/:projectId/slack-chat-default", async (c) => {
    const projectId = c.req.param("projectId");
    await requireProjectManager(c, projectId);
    const install = await findInstallation(projectId);
    if (!install) return c.json({ error: "slack not installed" }, 400);

    const body = (await c.req.json().catch(() => ({}))) as { enabled?: unknown };
    const enabled = typeof body.enabled === "boolean" ? body.enabled : true;

    await db.transaction(async (tx) => {
      if (enabled) {
        await tx
          .update(schema.slackInstallations)
          .set({ isDefaultChatProject: false })
          .where(
            and(
              eq(schema.slackInstallations.teamId, install.teamId),
              eq(schema.slackInstallations.isDefaultChatProject, true),
            ),
          );
      }
      await tx
        .update(schema.slackInstallations)
        .set({ isDefaultChatProject: enabled })
        .where(eq(schema.slackInstallations.id, install.id));
    });
    return c.json({ ok: true, isDefaultChatProject: enabled });
  });
}

async function findInstallation(projectId: string) {
  return db.query.slackInstallations.findFirst({
    where: and(
      eq(schema.slackInstallations.projectId, projectId),
      isNull(schema.slackInstallations.revokedAt),
    ),
  });
}

async function upsertInstallation(v: {
  projectId: string;
  teamId: string;
  teamName: string | null;
  botUserId: string | null;
  botAccessToken: string;
  scope: string | null;
  installedByUserId: string | null;
}): Promise<void> {
  await db
    .insert(schema.slackInstallations)
    .values({
      projectId: v.projectId,
      teamId: v.teamId,
      teamName: v.teamName,
      botUserId: v.botUserId,
      botAccessToken: v.botAccessToken,
      scope: v.scope,
      installedByUserId: v.installedByUserId,
      installedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [schema.slackInstallations.projectId, schema.slackInstallations.teamId],
      set: {
        teamName: v.teamName,
        botUserId: v.botUserId,
        botAccessToken: v.botAccessToken,
        scope: v.scope,
        installedByUserId: v.installedByUserId,
        revokedAt: null,
        // Reinstall mints a fresh bot token and invalidates the old one, so
        // record the refresh time — this is what the team-wide fallback orders
        // by to find the row holding the currently-live token.
        installedAt: new Date(),
      },
    });
}

async function handleSlackEventEnvelope(payload: SlackEventEnvelope): Promise<void> {
  const event = payload.event;
  if (!event || (event.type !== "message" && event.type !== "app_mention")) return;
  if (event.subtype || event.bot_id) return;
  if (!event.channel || !event.ts || !event.user) return;
  if (typeof event.text !== "string" || event.text.trim().length === 0) return;
  const inbound: SlackInboundEvent = {
    ...event,
    channel: event.channel,
    ts: event.ts,
    user: event.user,
    text: event.text,
  };

  // Open incident threads continue the investigation. Once an incident is
  // closed, the thread becomes an ordinary Q&A surface: an explicit mention
  // starts a chat and subsequent replies continue it through handleChatEvent.
  // A channel mention fires BOTH a `message` and an `app_mention` event (with
  // distinct event_ids), so open incidents process only the `message` copy —
  // otherwise one reply would record two human_reply events.
  if (inbound.thread_ts && inbound.thread_ts !== inbound.ts) {
    const incident = await db.query.incidents.findFirst({
      where: and(
        eq(schema.incidents.slackChannelId, inbound.channel),
        eq(schema.incidents.slackThreadTs, inbound.thread_ts),
      ),
    });
    if (incident) {
      const route = slackIncidentThreadRoute({
        incidentStatus: incident.status,
        eventType: inbound.type,
      });
      if (route === "ignore") return;
      if (route === "incident") {
        await handleIncidentThreadReply(payload, inbound, incident);
        return;
      }
    }
  }

  await handleChatEvent(payload, inbound);
}

export function slackIncidentThreadRoute(input: {
  incidentStatus: schema.IncidentStatus;
  eventType?: string;
}): "incident" | "chat" | "ignore" {
  if (input.incidentStatus !== "open") return "chat";
  return input.eventType === "message" ? "incident" : "ignore";
}

type SlackInboundEvent = NonNullable<SlackEventEnvelope["event"]> & {
  channel: string;
  ts: string;
  user: string;
  text: string;
};

async function handleIncidentThreadReply(
  payload: SlackEventEnvelope,
  event: SlackInboundEvent,
  incident: schema.Incident,
): Promise<void> {
  if (!event.thread_ts) return;

  const installation = await installationForIncident({
    pinnedId: incident.slackInstallationId,
    teamId: payload.team_id ?? "",
  });
  const botUserId =
    installation?.botUserId ??
    payload.authorizations?.find((authorization) => authorization.is_bot !== false)?.user_id ??
    null;
  if (!installation || !botUserId) {
    log.warn(
      { incident_id: incident.id, has_installation: Boolean(installation) },
      "slack reply intent could not resolve the incident bot identity",
    );
    return;
  }

  const intent = await classifyIncidentSlackReply(
    {
      botToken: installation.botAccessToken,
      botUserId,
      channelId: event.channel,
      threadTs: event.thread_ts,
      currentMessage: {
        ts: event.ts,
        userId: event.user,
        text: event.text,
      },
    },
    {
      apiKey: process.env.ANTHROPIC_API_KEY ?? "",
      model: process.env.ANTHROPIC_SLACK_REPLY_INTENT_MODEL ?? "claude-sonnet-4-6",
    },
  );
  log.info(
    {
      incident_id: incident.id,
      slack_message_ts: event.ts,
      decision: intent.decision,
      confidence: intent.confidence,
      source: intent.source,
      reason: intent.reason,
    },
    "classified Slack incident thread reply intent",
  );
  if (intent.decision !== "intended") return;

  // Talking to the investigation: continue the SAME durable session where we
  // can (resume / steer), and only spin a fresh run when no session survives.
  // The shared path records the message, reactivates a terminal run, or
  // cold-starts — all channels go through it.
  const result = await recordInboundInteraction(db, {
    incidentId: incident.id,
    interaction: {
      channel: "slack_reply",
      author: event.user ?? null,
      text: event.text.trim(),
      occurredAt: new Date().toISOString(),
    },
    dedupeKey: payload.event_id
      ? `slack:${payload.event_id}`
      : `slack:${event.channel}:${event.ts}`,
    detail: {
      slackEventId: payload.event_id ?? null,
      slackUserId: event.user ?? null,
      slackChannelId: event.channel,
      slackThreadTs: event.thread_ts,
      slackMessageTs: event.ts,
    },
  });

  if (result.outcome === "duplicate") return;
  if (result.outcome === "skipped") {
    logger.info(
      { scope: "slack", incident_id: incident.id, reason: result.reason },
      "slack reply did not continue the investigation",
    );
    return;
  }

  // One instant acknowledgement in the originating thread so the human knows
  // the message landed, rather than silence until the agent replies.
  await postSlackThreadReply({
    botToken: installation.botAccessToken,
    channel: event.channel,
    threadTs: event.thread_ts,
    text: ":mag: On it — I'll follow up in this thread.",
  });
}

// Q&A chat routing: a bot mention (channel) or any human message (DM) opens a
// chat; further messages in the same thread / DM continue it without needing
// another mention. The mention double-delivery (message + app_mention) and
// Events API retries collapse onto the (channel, ts)-keyed dedupe in
// recordInboundChatMessage, so both copies are safe to route.
// DMs are one continuous conversation per channel (no thread anchor); channel
// chats anchor on the thread, with a top-level mention rooting a new thread at
// its own ts.
export function chatAnchorThreadTs(event: {
  channel_type?: string;
  thread_ts?: string;
  ts: string;
}): string | null {
  return event.channel_type === "im" ? null : (event.thread_ts ?? event.ts);
}

async function handleChatEvent(
  payload: SlackEventEnvelope,
  event: SlackInboundEvent,
): Promise<void> {
  const teamId = payload.team_id ?? "";
  if (!teamId) return;
  const isDm = event.channel_type === "im";
  const anchorThreadTs = chatAnchorThreadTs(event);
  // A channel mention arrives twice (message + app_mention). Chat writes are
  // deduped on (channel, ts) either way; user-visible fallback notices below
  // are NOT, so only the `message` copy may post them. DMs and mentions from
  // installs without the message scopes still deliver via app_mention alone —
  // for those there is no twin, so the gate never drops a notice entirely.
  const mayPostNotices = event.type === "message" || isDm;

  const existing = await findChatByAnchor(db, teamId, event.channel, anchorThreadTs);

  const installations = await listInstallationsForTeam(teamId);
  const botUserId =
    installations.find((i) => i.botUserId)?.botUserId ??
    payload.authorizations?.find((a) => a.is_bot !== false)?.user_id ??
    null;
  if (event.user === botUserId) return;

  const mentioned = mentionsBot(event.text, botUserId) || event.type === "app_mention";
  // A channel message that neither mentions the bot nor lands in an existing
  // chat thread is ordinary team conversation.
  if (!existing && !isDm && !mentioned) return;

  const text = stripBotMention(event.text, botUserId).trim();
  if (!text) return;

  let target: {
    projectId: string;
    installationId: string;
    installation: schema.SlackInstallation | null;
  } | null = null;
  if (existing) {
    const pinned = existing.slackInstallationId
      ? (installations.find((i) => i.id === existing.slackInstallationId) ?? null)
      : null;
    target = {
      projectId: existing.projectId,
      installationId: existing.slackInstallationId ?? pinned?.id ?? "",
      installation: pinned ?? installations[0] ?? null,
    };
    if (!target.installationId && installations[0]) target.installationId = installations[0].id;
    if (!target.installationId) return;
  } else {
    const resolution = resolveChatInstallation(
      installations.map((i) => ({
        id: i.id,
        projectId: i.projectId,
        channelId: i.channelId,
        isDefaultChatProject: i.isDefaultChatProject,
        installedAt: i.installedAt,
        createdAt: i.createdAt,
      })),
      event.channel,
    );
    if (resolution.outcome === "none") return;
    if (resolution.outcome === "ambiguous") {
      // Only a fresh mention gets the disambiguation nudge; never guess.
      // Gated to one event copy so the message/app_mention twins can't post
      // the nudge twice.
      if ((!mentioned && !isDm) || !mayPostNotices) return;
      const anyInstall = await findInstallationForTeam(teamId);
      if (anyInstall) {
        await postSlackThreadReply({
          botToken: anyInstall.botAccessToken,
          channel: event.channel,
          threadTs: isDm ? null : anchorThreadTs,
          text: ":grey_question: This workspace is connected to several Superlog projects, so I don't know which one you're asking about. Mention me in a project's incident channel, or mark one project as the default for questions in its Superlog Slack settings.",
        });
      }
      return;
    }
    const row = installations.find((i) => i.id === resolution.installation.id) ?? null;
    if (!row) return;
    target = { projectId: row.projectId, installationId: row.id, installation: row };
  }

  const result = await recordInboundChatMessage(db, {
    projectId: target.projectId,
    slackInstallationId: target.installationId,
    slackTeamId: teamId,
    slackChannelId: event.channel,
    slackThreadTs: anchorThreadTs,
    authorSlackUserId: event.user ?? null,
    text,
    slackMessageTs: event.ts,
    // (channel, ts) — not the event id — so the app_mention/message twin
    // events for one mention dedupe against each other.
    dedupeKey: `slackchat:${event.channel}:${event.ts}`,
  });

  if (result.outcome === "duplicate") return;
  if (result.outcome === "skipped") {
    if (result.reason === "chat_disabled" && !existing && target.installation && mayPostNotices) {
      await postSlackThreadReply({
        botToken: target.installation.botAccessToken,
        channel: event.channel,
        threadTs: isDm ? null : anchorThreadTs,
        text: ":no_bell: Q&A chat is turned off for this project in Superlog's automation settings.",
      });
    }
    logger.info(
      { scope: "slack", project_id: target.projectId, reason: result.reason },
      "slack chat message skipped",
    );
    return;
  }

  // Ack only the message that opens a conversation; replies get the agent's
  // actual answer without an extra "on it" in between.
  if (result.created && target.installation) {
    await postSlackThreadReply({
      botToken: target.installation.botAccessToken,
      channel: event.channel,
      threadTs: isDm ? null : anchorThreadTs,
      text: ":mag: On it — I'll answer here shortly.",
    });
  }
}

// Every non-revoked installation row for a workspace (one per connected
// project). Callers pick between them via resolveChatInstallation.
async function listInstallationsForTeam(teamId: string) {
  if (!teamId) return [];
  return db.query.slackInstallations.findMany({
    where: and(
      eq(schema.slackInstallations.teamId, teamId),
      isNull(schema.slackInstallations.revokedAt),
    ),
    orderBy: desc(
      sql`coalesce(${schema.slackInstallations.installedAt}, ${schema.slackInstallations.createdAt})`,
    ),
  });
}

async function resolveUserOrg(
  c: Context<{ Variables: Vars }>,
): Promise<{ userId: string; orgId: string; projectId: string } | null> {
  const userId = c.var.userId;
  if (!userId) return null;
  const ctx = await resolveActiveOrgContext({
    userId,
    preferredOrgId: c.var.orgId,
  }).catch(() => null);
  if (!ctx) return null;
  return { userId: ctx.user.id, orgId: ctx.org.id, projectId: ctx.project.id };
}

async function requireProjectAccess(
  c: Context<{ Variables: Vars }>,
  projectId: string,
): Promise<{ userId: string; orgId: string }> {
  const ctx = await resolveUserOrg(c);
  if (!ctx) throw new HTTPException(401, { message: "not authenticated" });
  const project = await db.query.projects.findFirst({
    where: eq(schema.projects.id, projectId),
  });
  if (!project) throw new HTTPException(404, { message: "project not found" });
  if (project.orgId !== ctx.orgId) throw new HTTPException(403, { message: "forbidden" });
  return ctx;
}

async function requireProjectManager(
  c: Context<{ Variables: Vars }>,
  projectId: string,
): Promise<{ userId: string; orgId: string }> {
  const { access } = await requireProjectManagerContext(c, projectId);
  return { userId: access.userId, orgId: access.orgId };
}

async function resolveUserOrgManager(
  c: Context<{ Variables: Vars }>,
): Promise<{ userId: string; orgId: string; projectId: string } | null> {
  const ctx = await resolveUserOrg(c);
  if (!ctx) return null;
  await requireProjectManagerContext(c, ctx.projectId);
  return ctx;
}

// `userId` is the installer when the install was kicked off from the
// dashboard's authed flow; for the skill kickoff we don't have a signed-in
// user at issue time so it can be null. `userCode` is set only for
// skill-flow installs and is what the callback uses to bounce the user
// back to /activate on completion.
type StatePayload = {
  orgId: string;
  projectId: string;
  userId: string | null;
  userCode?: string;
};

function signState(p: StatePayload, secret: string): string {
  const body = `${p.orgId}.${p.projectId}.${p.userId ?? ""}.${p.userCode ?? ""}.${Date.now()}`;
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${Buffer.from(body, "utf8").toString("base64url")}.${sig}`;
}

function verifyState(state: string, secret: string): StatePayload | null {
  const [payloadB64, sig] = state.split(".");
  if (!payloadB64 || !sig) return null;
  const body = Buffer.from(payloadB64, "base64url").toString("utf8");
  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  const provided = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (provided.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(provided, expectedBuf)) return null;
  const parts = body.split(".");
  // Current format is `${orgId}.${projectId}.${userId}.${userCode}.${ts}` (5
  // parts). Older 3- or 4-part states (no projectId) are no longer accepted —
  // they expire after 10 min anyway, so the only impact is users who started
  // an install flow within ~10 min of the deploy seeing an "invalid state"
  // error and having to click install again.
  if (parts.length !== 5) return null;
  const [orgId, projectId, userId, userCodeRaw, tsRaw] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (!orgId || !projectId || !tsRaw) return null;
  const ts = Number(tsRaw);
  if (!Number.isFinite(ts) || Date.now() - ts > 10 * 60 * 1000) return null;
  return { orgId, projectId, userId: userId || null, userCode: userCodeRaw || undefined };
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

function resolveSlackRedirectUrl(c: Context, configuredRedirectUrl: string): string {
  const origin = c.req.header("origin") ?? "";
  const host = c.req.header("host") ?? "";
  if (
    origin === "http://localhost:5173" ||
    origin === "http://127.0.0.1:5173" ||
    host === "localhost:4100" ||
    host === "127.0.0.1:4100"
  ) {
    return "http://localhost:4100/slack/oauth/callback";
  }
  return configuredRedirectUrl;
}

function verifySlackSignature(c: Context, signingSecret: string, rawBody: string): boolean {
  const signature = c.req.header("x-slack-signature");
  const timestamp = c.req.header("x-slack-request-timestamp");
  if (!signature || !timestamp) return false;

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds) > 60 * 5) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${crypto.createHmac("sha256", signingSecret).update(base).digest("hex")}`;
  const providedBuffer = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (providedBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

type SlackOAuthResponse = {
  ok: boolean;
  error?: string;
  access_token?: string;
  scope?: string;
  bot_user_id?: string;
  team?: { id?: string; name?: string };
};

type SlackConversationsList = {
  ok: boolean;
  error?: string;
  channels?: { id: string; name: string; is_private?: boolean }[];
  response_metadata?: { next_cursor?: string };
};

export type SlackChannelSummary = { id: string; name: string; isPrivate: boolean };

export type ListSlackChannelsResult =
  | { ok: true; channels: SlackChannelSummary[] }
  | { ok: false; error: string };

// Slack's conversations.list returns at most `limit` channels per page; a big
// workspace needs cursor pagination or the list silently truncates — and a
// private channel the bot was invited to can fall off the end and "disappear"
// from the dropdown. Walk every page (capped) and aggregate. Note: even with
// groups:read, Slack only returns private channels the bot is a *member* of,
// so the user still has to `/invite` the bot to a private channel for it to
// show up at all.
export async function listSlackChannels(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ListSlackChannelsResult> {
  const channels: SlackChannelSummary[] = [];
  let cursor: string | undefined;
  // Hard page cap (200 * 50 = 10k channels) so a misbehaving cursor can't loop.
  for (let page = 0; page < 50; page++) {
    const url = new URL("https://slack.com/api/conversations.list");
    url.searchParams.set("types", "public_channel,private_channel");
    url.searchParams.set("exclude_archived", "true");
    url.searchParams.set("limit", "200");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetchImpl(url, {
      headers: { authorization: `Bearer ${token}` },
    });
    const data = (await res.json()) as SlackConversationsList;
    if (!data.ok) return { ok: false, error: data.error ?? "unknown" };
    for (const ch of data.channels ?? []) {
      channels.push({ id: ch.id, name: ch.name, isPrivate: ch.is_private ?? false });
    }
    cursor = data.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }
  if (cursor) return { ok: false, error: "pagination_limit_exceeded" };
  return { ok: true, channels };
}

export type JoinSlackChannelResult = { ok: true } | { ok: false; error: string };

// Membership repair for the notification channel: chat:write.public lets the
// bot post to public channels it never joined, but Slack only delivers
// `message.channels` events for channels the bot is a member of — so thread
// replies in a never-joined channel reach nobody. Join is idempotent
// (`already_in_channel` comes back as ok:true with a warning). Private
// channels can't be self-joined, but they don't have this gap: posting there
// already requires an invite. Callers treat failure as best-effort —
// `missing_scope` means a pre-channels:join installation that needs a
// re-auth (or a manual invite).
export async function joinSlackChannel(
  token: string,
  channelId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<JoinSlackChannelResult> {
  try {
    const res = await fetchImpl("https://slack.com/api/conversations.join", {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ channel: channelId }),
      // Callers sit on user-facing requests (OAuth redirect, route PUT); a
      // Slack stall must fall through to best-effort, not hang the response.
      signal: AbortSignal.timeout(5000),
    });
    const data = (await res.json()) as { ok: boolean; error?: string };
    if (!data.ok) return { ok: false, error: data.error ?? "unknown" };
    return { ok: true };
  } catch {
    return { ok: false, error: "network_error" };
  }
}

// Slack interactivity envelope. `view.state.values` is keyed by block_id
// then action_id; for the feedback modal that's
// `state.values.feedback_body.value.value` (block_id="feedback_body",
// action_id="value", input type plain_text_input).
type SlackInteractivityPayload = {
  type?: string;
  trigger_id?: string;
  team?: { id?: string };
  user?: { id?: string; name?: string };
  // `action_ts` is Slack's per-click timestamp. It is stable across Slack's
  // interactivity retries (fired when our ack misses the 3s window), so it
  // gives a natural idempotency key for the click.
  actions?: Array<{ action_id?: string; value?: string; action_ts?: string }>;
  view?: {
    callback_id?: string;
    state?: {
      values?: {
        feedback_body?: {
          value?: { value?: string };
        };
      };
    };
  };
};

type SlackEventEnvelope = {
  type?: string;
  challenge?: string;
  event_id?: string;
  team_id?: string;
  // The app's own identity in this workspace; fallback for legacy
  // installation rows that predate the bot_user_id column.
  authorizations?: Array<{ user_id?: string; is_bot?: boolean }>;
  event?: {
    type?: string;
    subtype?: string;
    text?: string;
    channel?: string;
    // "im" for DMs with the bot (delivered via the im:history scope).
    channel_type?: string;
    thread_ts?: string;
    ts?: string;
    user?: string;
    bot_id?: string;
  };
};
