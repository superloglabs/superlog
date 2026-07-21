import { db, environmentFromResourceAttrs, schema } from "@superlog/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { buildIncidentUrl } from "../../incident-route.js";
import { logger } from "../../logger.js";
import { isStaleSlackAnchorError } from "../../slack-pinning.js";
import {
  type SlackJoinResult,
  type SlackTarget,
  fetchChannelMembership,
  joinSlackChannel,
  postSlackMessage,
  updateSlackMessage,
} from "./api.js";

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:5173";

async function incidentUrlForProject(projectId: string, incidentId: string): Promise<string> {
  const [route] = await db
    .select({ orgSlug: schema.orgs.slug, projectSlug: schema.projects.slug })
    .from(schema.projects)
    .innerJoin(schema.orgs, eq(schema.orgs.id, schema.projects.orgId))
    .where(eq(schema.projects.id, projectId))
    .limit(1);
  return route
    ? buildIncidentUrl(WEB_ORIGIN, { ...route, incidentId })
    : `${WEB_ORIGIN}/incidents/${incidentId}`;
}

async function fetchSlackTarget(projectId: string): Promise<SlackTarget | null> {
  const rows = await db.execute<{
    installation_id: string;
    channel_id: string;
    bot_access_token: string;
  }>(sql`
    SELECT si.id AS installation_id,
           si.channel_id,
           si.bot_access_token
    FROM slack_installations si
    WHERE si.project_id = ${projectId}
      AND si.channel_id IS NOT NULL
      AND si.revoked_at IS NULL
    LIMIT 1
  `);
  const row = (
    rows as unknown as Array<{
      installation_id: string;
      channel_id: string;
      bot_access_token: string;
    }>
  )[0];
  if (!row) return null;
  return {
    installationId: row.installation_id,
    channelId: row.channel_id,
    botToken: row.bot_access_token,
  };
}

// All distinct connected Slack channels across an org's projects, for org-level
// (not incident-level) notifications like usage-limit warnings. Slack installs
// are per-project, so an org with several connected projects may have several
// channels; we post once per distinct channel. Picks the most recently installed
// row per channel for its bot token.
export async function fetchSlackTargetsForOrg(orgId: string): Promise<SlackTarget[]> {
  const rows = await db.execute<{
    installation_id: string;
    channel_id: string;
    bot_access_token: string;
  }>(sql`
    SELECT DISTINCT ON (si.channel_id)
           si.id AS installation_id,
           si.channel_id,
           si.bot_access_token
    FROM slack_installations si
    JOIN projects p ON p.id = si.project_id
    WHERE p.org_id = ${orgId}
      AND si.channel_id IS NOT NULL
      AND si.revoked_at IS NULL
    ORDER BY si.channel_id, coalesce(si.installed_at, si.created_at) DESC, si.id DESC
  `);
  return (
    rows as unknown as Array<{
      installation_id: string;
      channel_id: string;
      bot_access_token: string;
    }>
  ).map((row) => ({
    installationId: row.installation_id,
    channelId: row.channel_id,
    botToken: row.bot_access_token,
  }));
}

async function fetchSlackTargetForIncident(
  incident: Pick<schema.Incident, "projectId" | "slackChannelId" | "slackInstallationId">,
): Promise<SlackTarget | null> {
  if (incident.slackChannelId && incident.slackInstallationId) {
    const installation = await db.query.slackInstallations.findFirst({
      where: and(
        eq(schema.slackInstallations.id, incident.slackInstallationId),
        isNull(schema.slackInstallations.revokedAt),
      ),
    });
    if (installation) {
      return {
        installationId: installation.id,
        channelId: incident.slackChannelId,
        botToken: installation.botAccessToken,
      };
    }
  }
  return fetchSlackTarget(incident.projectId);
}

async function clearIncidentSlackAnchor(incidentId: string): Promise<void> {
  await db
    .update(schema.incidents)
    .set({
      slackChannelId: null,
      slackThreadTs: null,
      slackInstallationId: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.incidents.id, incidentId));
}

// Slack mrkdwn requires &, <, > escaped inside link labels, otherwise a title
// like `a > b` truncates the `<url|label>` span. Only the link path needs this;
// plain `*title*` text renders those characters literally. (Mirrors the api
// app's apps/api/src/slack-format.ts — keep the rules in sync across apps.)
function escapeSlackLinkText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Escape the URL side of a `<url|label>` link: `|` separates url from label and
// `>` closes the link, so a URL containing either truncates or injects
// formatting. `titleUrl` is internally generated and safe, but `links` carries
// generic PR/ticket URLs from callers, so escape both. Percent-encode rather
// than drop, since both chars are valid in a URL.
function escapeSlackLinkUrl(url: string): string {
  return url.replace(/\|/g, "%7C").replace(/>/g, "%3E");
}

export function incidentBlocks(opts: {
  emoji: string;
  status: string;
  title: string;
  incidentCodename?: string | null;
  // When set, the title renders as a link to the incident. Preferred over a
  // standalone "Open in Superlog" button — it frees an actions-row slot.
  titleUrl?: string | null;
  tagline?: string | null;
  service?: string | null;
  environment?: string | null;
  buttons: Array<{ text: string; url?: string; actionId: string }>;
  // Auxiliary links rendered as a body line (`View PR · View ticket · …`)
  // rather than buttons — keeps informational URLs out of the actions row.
  links?: Array<{ text: string; url: string }>;
  incidentId?: string;
  showResolveButton?: boolean;
  // Adds a "Merge PR" action button (merge_pr:<incidentId>) — set on the
  // PR-ready root message so the client can land the fix from Slack.
  showMergePrButton?: boolean;
  // Adds 👍/👎 rating buttons (rate_incident:<rating>:<incidentId>). Set on
  // states where there's an investigation worth rating.
  showFeedbackButtons?: boolean;
  // Adds a one-shot "Open a PR" action for a findings-only investigation.
  showOpenPrButton?: boolean;
  // Adds a "Do not silence, resolve" button (unsilence_resolve:<incidentId>).
  // Set on the closed-PR resolution message, where the resolve cascade
  // silenced the incident's issues — the click flips them back to `resolved`
  // so a recurrence opens a chained incident again.
  showUnsilenceButton?: boolean;
}): unknown[] {
  const titleText = opts.titleUrl
    ? `*<${escapeSlackLinkUrl(opts.titleUrl)}|${escapeSlackLinkText(opts.title)}>*`
    : `*${opts.title}*`;
  const lines = opts.incidentCodename
    ? [
        `:${opts.emoji}: *${opts.status}*`,
        `*Incident* \`${opts.incidentCodename}\``,
        `*Error*:\n\`\`\`\n${opts.title}\n\`\`\``,
      ]
    : [`:${opts.emoji}: *${opts.status}*`, titleText];
  if (opts.tagline) lines.push(`_${opts.tagline}_`);
  // `service · environment`, each a code chip; both only appear when present
  // on the triggering error. The project is implicit — the Slack channel is
  // per-project — so it's not repeated here.
  const context = [opts.service, opts.environment]
    .filter((part): part is string => Boolean(part))
    .map((part) => `\`${part}\``)
    .join(" · ");
  if (context) lines.push(context);
  if (opts.links && opts.links.length > 0) {
    lines.push(
      opts.links
        .map((link) => `<${escapeSlackLinkUrl(link.url)}|${escapeSlackLinkText(link.text)}>`)
        .join("  ·  "),
    );
  }
  const blocks: unknown[] = [{ type: "section", text: { type: "mrkdwn", text: lines.join("\n") } }];
  const elements: unknown[] = opts.buttons.map((btn) => ({
    type: "button",
    text: { type: "plain_text", text: btn.text, emoji: true },
    ...(btn.url ? { url: btn.url } : {}),
    action_id: btn.actionId,
  }));
  if (opts.incidentId) {
    if (opts.showOpenPrButton) {
      elements.push({
        type: "button",
        text: { type: "plain_text", text: "Open a PR", emoji: true },
        style: "primary",
        action_id: `open_pr:${opts.incidentId}`,
        confirm: {
          title: { type: "plain_text", text: "Open a PR" },
          text: {
            type: "mrkdwn",
            text: "Starts a new agent run to implement the confirmed fix, validate it, and open a pull request.",
          },
          confirm: { type: "plain_text", text: "Start" },
          deny: { type: "plain_text", text: "Cancel" },
        },
      });
    }
    if (opts.showMergePrButton) {
      elements.push({
        type: "button",
        text: { type: "plain_text", text: "🔀 Merge PR", emoji: true },
        style: "primary",
        action_id: `merge_pr:${opts.incidentId}`,
        confirm: {
          title: { type: "plain_text", text: "Merge the agent's PR" },
          text: {
            type: "mrkdwn",
            text: "Squash-merges the agent's open PR on GitHub and resolves this incident.",
          },
          confirm: { type: "plain_text", text: "Merge" },
          deny: { type: "plain_text", text: "Cancel" },
        },
      });
    }
    if (opts.showResolveButton) {
      elements.push({
        type: "button",
        text: { type: "plain_text", text: "✅ Problem resolved", emoji: true },
        style: opts.showMergePrButton ? undefined : "primary",
        action_id: `resolve_incident:${opts.incidentId}`,
        confirm: {
          title: { type: "plain_text", text: "Problem resolved" },
          text: {
            type: "mrkdwn",
            text: "Marks this incident and its issues as resolved. If the underlying error recurs, a new incident opens with this investigation's findings attached.",
          },
          confirm: { type: "plain_text", text: "Resolve" },
          deny: { type: "plain_text", text: "Cancel" },
        },
      });
      elements.push({
        type: "button",
        text: { type: "plain_text", text: "🔕 Not an issue", emoji: true },
        action_id: `not_an_issue:${opts.incidentId}`,
        confirm: {
          title: { type: "plain_text", text: "Not an issue" },
          text: {
            type: "mrkdwn",
            text: "Resolves this incident and silences its issues — future occurrences will not open incidents.",
          },
          confirm: { type: "plain_text", text: "Silence" },
          deny: { type: "plain_text", text: "Cancel" },
        },
      });
    }
    if (opts.showUnsilenceButton) {
      elements.push({
        type: "button",
        text: { type: "plain_text", text: "Do not silence, resolve", emoji: true },
        action_id: `unsilence_resolve:${opts.incidentId}`,
      });
    }
    if (opts.showFeedbackButtons) {
      elements.push({
        type: "button",
        text: { type: "plain_text", text: "👍 Helpful", emoji: true },
        action_id: `rate_incident:helpful:${opts.incidentId}`,
      });
      elements.push({
        type: "button",
        text: { type: "plain_text", text: "👎 Not helpful", emoji: true },
        action_id: `rate_incident:unhelpful:${opts.incidentId}`,
      });
    }
  }
  if (elements.length > 0) {
    blocks.push({ type: "actions", elements });
  }
  return blocks;
}

export async function updateIncidentMainMessage(
  incidentId: string,
  text: string,
  blocks: unknown[],
): Promise<void> {
  const incident = await db.query.incidents.findFirst({
    where: eq(schema.incidents.id, incidentId),
  });
  if (!incident?.slackThreadTs || !incident.slackChannelId) return;
  const target = await fetchSlackTargetForIncident(incident);
  if (!target) return;
  const data = await updateSlackMessage({
    target,
    ts: incident.slackThreadTs,
    text,
    blocks,
  });
  if (data && !data.ok && isStaleSlackAnchorError(data.error)) {
    logger.info(
      { scope: "slack", incidentId, channel: target.channelId, error: data.error },
      "incident slack anchor went stale; clearing for re-root on next thread post",
    );
    await clearIncidentSlackAnchor(incidentId);
  }
}

// Thread replies to the agent only arrive from channels the bot is a member
// of; posting alone works unjoined (chat:write.public). When the bot can't
// self-join AND is provably not a member, the root notification carries an
// invite hint — otherwise users reply into the void with no error anywhere.
// Membership `null` means Slack didn't say; stay silent rather than nag on a
// flaky lookup.
export function needsInviteHint(join: SlackJoinResult, isMember: boolean | null): boolean {
  return !join.ok && isMember === false;
}

export function inviteHintBlock(): unknown {
  return {
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: "⚠️ The Superlog bot isn't a member of this channel, so thread replies won't reach the agent. `/invite` the bot here (or reconnect Slack in project settings) to enable replies.",
      },
    ],
  };
}

// Join the channel (idempotent) so replies in the new thread reach the Events
// API; when joining is impossible, return the invite hint to append to the
// root blocks. One extra Slack call per NEW incident root — thread replies and
// updates skip this entirely.
async function ensureJoinedOrHint(target: SlackTarget): Promise<unknown[]> {
  const join = await joinSlackChannel(target);
  if (join.ok) return [];
  const isMember = await fetchChannelMembership(target);
  logger.info(
    {
      scope: "slack",
      channel: target.channelId,
      join_error: join.error,
      is_member: isMember,
    },
    "slack channel self-join failed before incident root post",
  );
  return needsInviteHint(join, isMember) ? [inviteHintBlock()] : [];
}

async function postAndRememberIncidentRoot(opts: {
  incidentId: string;
  target: SlackTarget;
  text: string;
  blocks?: unknown[];
}): Promise<string | null> {
  const hintBlocks = await ensureJoinedOrHint(opts.target);
  const data = await postSlackMessage({
    target: opts.target,
    text: opts.text,
    blocks: opts.blocks ? [...opts.blocks, ...hintBlocks] : undefined,
  });
  if (!data?.ok || !data.ts) return null;
  await db
    .update(schema.incidents)
    .set({
      slackChannelId: opts.target.channelId,
      slackThreadTs: data.ts,
      slackInstallationId: opts.target.installationId,
      lastSlackPostedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.incidents.id, opts.incidentId));
  return data.ts;
}

export async function postIncidentRootMessage(opts: {
  incident: schema.Incident;
  projectId: string;
  firstIssue: schema.Issue;
}): Promise<void> {
  if (opts.incident.slackThreadTs) return;
  const target = await fetchSlackTarget(opts.projectId);
  if (!target) return;
  const incidentUrl = await incidentUrlForProject(opts.projectId, opts.incident.id);
  const text = `:rotating_light: New incident: ${opts.firstIssue.title}`;
  const blocks = incidentBlocks({
    emoji: "rotating_light",
    status: "New Incident",
    title: opts.firstIssue.title,
    service: opts.firstIssue.service,
    environment:
      opts.incident.environment ??
      environmentFromResourceAttrs(opts.firstIssue.lastSample?.resourceAttrs),
    titleUrl: incidentUrl,
    buttons: [],
    incidentId: opts.incident.id,
    showResolveButton: true,
    showFeedbackButtons: true,
  });
  await postAndRememberIncidentRoot({ incidentId: opts.incident.id, target, text, blocks });
}

async function createIncidentRootInCurrentRoute(
  incident: schema.Incident,
): Promise<{ target: SlackTarget; threadTs: string } | null> {
  const target = await fetchSlackTarget(incident.projectId);
  if (!target) return null;
  const incidentUrl = await incidentUrlForProject(incident.projectId, incident.id);
  const text = `:rotating_light: Incident: ${incident.title}`;
  const blocks = incidentBlocks({
    emoji: "rotating_light",
    status: "Incident",
    title: incident.title,
    service: incident.service,
    environment: incident.environment,
    titleUrl: incidentUrl,
    buttons: [],
    incidentId: incident.id,
    showResolveButton: true,
    showFeedbackButtons: true,
  });
  const threadTs = await postAndRememberIncidentRoot({
    incidentId: incident.id,
    target,
    text,
    blocks,
  });
  return threadTs ? { target, threadTs } : null;
}

export async function postIncidentThreadMessage(
  incidentId: string,
  summary: string,
): Promise<void> {
  const incident = await db.query.incidents.findFirst({
    where: eq(schema.incidents.id, incidentId),
  });
  if (!incident) return;

  if (incident.slackThreadTs && incident.slackChannelId) {
    const target = await fetchSlackTargetForIncident(incident);
    if (!target) return;
    const data = await postSlackMessage({
      target,
      text: summary,
      threadTs: incident.slackThreadTs,
    });
    if (data?.ok) {
      await db
        .update(schema.incidents)
        .set({ lastSlackPostedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.incidents.id, incidentId));
      return;
    }
    if (!data || !isStaleSlackAnchorError(data.error)) return;
    logger.info(
      { scope: "slack", incidentId, channel: target.channelId, error: data.error },
      "incident slack anchor went stale; creating fresh root in current route",
    );
    await clearIncidentSlackAnchor(incidentId);
  }

  const refreshed =
    (await db.query.incidents.findFirst({ where: eq(schema.incidents.id, incidentId) })) ??
    incident;
  const created = await createIncidentRootInCurrentRoute(refreshed);
  if (!created) return;
  const reply = await postSlackMessage({
    target: created.target,
    text: summary,
    threadTs: created.threadTs,
  });
  if (!reply?.ok) return;
  await db
    .update(schema.incidents)
    .set({ lastSlackPostedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.incidents.id, incidentId));
}
