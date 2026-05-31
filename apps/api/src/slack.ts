import crypto from "node:crypto";
import {
  confirmResolutionProposal,
  db,
  dismissResolutionProposal,
  resolveIncident,
  schema,
  syncLoopsContactsForOrg,
} from "@superlog/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { recordFeedback } from "./feedback.js";
import { getDeviceFlow, getSkillDeviceForIntegration } from "./gateway.js";
import { logger } from "./logger.js";
import { resolveActiveOrgContext } from "./org-context.js";

const log = logger.child({ scope: "slack" });

const SCOPES =
  "chat:write,chat:write.public,channels:read,groups:read,channels:history,groups:history";

type Vars = { userId: string; orgId: string | null };

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
    const err = c.req.query("error");
    if (err) return c.redirect(`${callbackWebOrigin}/?slack=denied`, 302);

    const code = c.req.query("code");
    const state = c.req.query("state") ?? "";
    if (!code) return c.redirect(`${callbackWebOrigin}/?slack=error`, 302);

    const decoded = verifyState(state, stateSecret);
    if (!decoded) return c.json({ error: "invalid state" }, 400);
    const orgId = decoded.orgId;
    const projectId = decoded.projectId;
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

    try {
      await handleSlackEventEnvelope(payload);
    } catch (err) {
      log.error(
        { err, event_type: payload.event?.type, event_id: payload.event_id },
        "slack event handler failed",
      );
      throw err;
    }
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
    return c.json({ ok: true });
  });
}

// Block_actions arrive when someone clicks a non-URL button in a message.
// Recognized action_ids (all encoded by the worker's incidentBlocks builder
// or the sweep proposal posting):
//   - `give_feedback:<incident-uuid>` → opens a feedback modal
//   - `resolve_incident:<incident-uuid>` → flips the incident to resolved
//     attributed to the Slack user who clicked
async function handleSlackBlockActions(payload: SlackInteractivityPayload): Promise<void> {
  const action = payload.actions?.[0];
  if (!action) return;
  const actionId = action.action_id ?? "";

  if (actionId.startsWith("resolve_incident:")) {
    const incidentId = actionId.slice("resolve_incident:".length);
    if (incidentId) await handleSlackResolveIncident(incidentId, payload);
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
  const installation = await findInstallationForTeam(payload.team?.id ?? "");
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
): Promise<void> {
  const incident = await db.query.incidents.findFirst({
    where: eq(schema.incidents.id, incidentId),
  });
  if (!incident) {
    log.warn({ incidentId }, "resolve_incident click for unknown incident");
    return;
  }
  if (incident.status !== "open") {
    log.info(
      { incidentId, status: incident.status },
      "resolve_incident click on already-closed incident, ignoring",
    );
    return;
  }

  const slackUserId = payload.user?.id ?? null;
  const slackUserName = payload.user?.name ?? null;
  const attribution = slackUserId ? `<@${slackUserId}>` : (slackUserName ?? "a teammate");

  const { resolved } = await resolveIncident({
    incidentId,
    kind: "slack_manual",
    reasonCode: "slack_manual",
    reasonText: `Resolved from Slack by ${slackUserName ?? slackUserId ?? "unknown user"}.`,
    resolvedBySlackUserId: slackUserId,
    // No investigation context here — the incident may or may not have one;
    // the resolved_* columns on incidents are the audit-of-record for manual
    // resolves. Skip the investigation event to avoid coupling to a possibly-
    // unrelated latest investigation.
  });
  if (!resolved) {
    log.info({ incidentId }, "resolve_incident click lost race with concurrent close");
    return;
  }

  const installation = await findInstallationForTeam(payload.team?.id ?? "");
  if (!installation) {
    log.warn({ team_id: payload.team?.id, incidentId }, "no installation to post resolve reply");
    return;
  }
  if (incident.slackChannelId && incident.slackThreadTs) {
    await postSlackThreadReply({
      botToken: installation.botAccessToken,
      channel: incident.slackChannelId,
      threadTs: incident.slackThreadTs,
      text: `:white_check_mark: Incident resolved by ${attribution}. If the underlying error reappears it will re-open automatically.`,
    });
  }
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
  const installation = await findInstallationForTeam(payload.team?.id ?? "");
  if (!installation) return;

  // Re-render the proposal message: drop the buttons, swap in a status line
  // crediting the deciding user. The message lives in the incident thread,
  // so this update is non-destructive — the original incident root
  // message and earlier thread activity are untouched.
  const proposal = await db.query.incidentResolutionProposals.findFirst({
    where: eq(schema.incidentResolutionProposals.id, proposalId),
  });
  if (!proposal?.slackChannelId || !proposal.slackMessageTs) return;

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

async function postSlackThreadReply(opts: {
  botToken: string;
  channel: string;
  threadTs: string;
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
        thread_ts: opts.threadTs,
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
  });
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
    const ctx = await resolveUserOrg(c);
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
    const ctx = await resolveUserOrg(c);
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

    const url = new URL("https://slack.com/api/conversations.list");
    url.searchParams.set("types", "public_channel,private_channel");
    url.searchParams.set("exclude_archived", "true");
    url.searchParams.set("limit", "200");
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${row.botAccessToken}` },
    });
    const data = (await res.json()) as SlackConversationsList;
    if (!data.ok) {
      log.warn(
        { team_id: row.teamId, error: data.error ?? "unknown" },
        "slack conversations.list failed",
      );
      if (data.error === "not_authed" || data.error === "token_revoked") {
        await db
          .update(schema.slackInstallations)
          .set({ revokedAt: new Date() })
          .where(eq(schema.slackInstallations.id, row.id));
      }
      return c.json({ error: data.error ?? "unknown" }, 502);
    }
    const channels = (data.channels ?? []).map((ch) => ({
      id: ch.id,
      name: ch.name,
      isPrivate: ch.is_private ?? false,
    }));
    return c.json({ channels });
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
    await requireProjectAccess(c, projectId);
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
    return c.json({ ok: true, channelId, channelName });
  });

  app.delete("/api/projects/:projectId/slack-route", async (c) => {
    const projectId = c.req.param("projectId");
    await requireProjectAccess(c, projectId);
    const install = await findInstallation(projectId);
    if (install) {
      await db
        .update(schema.slackInstallations)
        .set({ channelId: null, channelName: null })
        .where(eq(schema.slackInstallations.id, install.id));
    }
    return c.json({ ok: true });
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
      },
    });
}

async function handleSlackEventEnvelope(payload: SlackEventEnvelope): Promise<void> {
  const event = payload.event;
  if (!event || event.type !== "message") return;
  if (event.subtype || event.bot_id) return;
  if (!event.channel || !event.thread_ts || !event.ts || event.thread_ts === event.ts) return;
  if (typeof event.text !== "string" || event.text.trim().length === 0) return;

  const incident = await db.query.incidents.findFirst({
    where: and(
      eq(schema.incidents.slackChannelId, event.channel),
      eq(schema.incidents.slackThreadTs, event.thread_ts),
    ),
  });
  if (!incident) return;

  const agentRun = await db.query.agentRuns.findFirst({
    where: eq(schema.agentRuns.incidentId, incident.id),
    orderBy: [desc(schema.agentRuns.createdAt)],
  });
  if (!agentRun || agentRun.state !== "awaiting_human") return;

  await db
    .insert(schema.incidentEvents)
    .values({
      agentRunId: agentRun.id,
      kind: "human_reply",
      summary: event.text.trim(),
      detail: {
        slackEventId: payload.event_id ?? null,
        slackUserId: event.user ?? null,
        slackChannelId: event.channel,
        slackThreadTs: event.thread_ts,
        slackMessageTs: event.ts,
      },
      dedupeKey: payload.event_id
        ? `slack:${payload.event_id}`
        : `slack:${event.channel}:${event.ts}`,
    })
    .onConflictDoNothing({
      target: [schema.incidentEvents.agentRunId, schema.incidentEvents.dedupeKey],
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
};

// Slack interactivity envelope. `view.state.values` is keyed by block_id
// then action_id; for the feedback modal that's
// `state.values.feedback_body.value.value` (block_id="feedback_body",
// action_id="value", input type plain_text_input).
type SlackInteractivityPayload = {
  type?: string;
  trigger_id?: string;
  team?: { id?: string };
  user?: { id?: string; name?: string };
  actions?: Array<{ action_id?: string; value?: string }>;
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
  event?: {
    type?: string;
    subtype?: string;
    text?: string;
    channel?: string;
    thread_ts?: string;
    ts?: string;
    user?: string;
    bot_id?: string;
  };
};
