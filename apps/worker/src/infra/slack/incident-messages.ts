import { db, environmentFromResourceAttrs, schema } from "@superlog/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { logger } from "../../logger.js";
import { isStaleSlackAnchorError } from "../../slack-pinning.js";
import { type SlackTarget, postSlackMessage, updateSlackMessage } from "./api.js";

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:5173";

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
    ORDER BY si.channel_id, si.installed_at DESC NULLS LAST
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

export function incidentBlocks(opts: {
  emoji: string;
  status: string;
  title: string;
  tagline?: string | null;
  projectName: string;
  service?: string | null;
  environment?: string | null;
  buttons: Array<{ text: string; url: string; actionId: string }>;
  incidentId?: string;
  showResolveButton?: boolean;
}): unknown[] {
  const lines = [`:${opts.emoji}: *${opts.status}*`, `*${opts.title}*`];
  if (opts.tagline) lines.push(`_${opts.tagline}_`);
  // `project · service · environment`, each a code chip; service/environment
  // only appear when present on the triggering error.
  const context = [opts.projectName, opts.service, opts.environment]
    .filter((part): part is string => Boolean(part))
    .map((part) => `\`${part}\``)
    .join(" · ");
  lines.push(context);
  const blocks: unknown[] = [{ type: "section", text: { type: "mrkdwn", text: lines.join("\n") } }];
  const elements: unknown[] = opts.buttons.map((btn) => ({
    type: "button",
    text: { type: "plain_text", text: btn.text, emoji: true },
    url: btn.url,
    action_id: btn.actionId,
  }));
  if (opts.incidentId) {
    if (opts.showResolveButton) {
      elements.push({
        type: "button",
        text: { type: "plain_text", text: "✅ Resolve", emoji: true },
        style: "primary",
        action_id: `resolve_incident:${opts.incidentId}`,
        confirm: {
          title: { type: "plain_text", text: "Resolve incident" },
          text: {
            type: "mrkdwn",
            text: "Marks this incident as resolved and closes its linked issues. If the underlying error reappears, the incident will re-open automatically.",
          },
          confirm: { type: "plain_text", text: "Resolve" },
          deny: { type: "plain_text", text: "Cancel" },
        },
      });
    }
    elements.push({
      type: "button",
      text: { type: "plain_text", text: "💬 Give feedback", emoji: true },
      action_id: `give_feedback:${opts.incidentId}`,
    });
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

async function postAndRememberIncidentRoot(opts: {
  incidentId: string;
  target: SlackTarget;
  text: string;
  blocks?: unknown[];
}): Promise<string | null> {
  const data = await postSlackMessage({
    target: opts.target,
    text: opts.text,
    blocks: opts.blocks,
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
  projectName: string;
  firstIssue: schema.Issue;
}): Promise<void> {
  if (opts.incident.slackThreadTs) return;
  const target = await fetchSlackTarget(opts.projectId);
  if (!target) return;
  const incidentUrl = `${WEB_ORIGIN}/incidents/${opts.incident.id}`;
  const text = `:rotating_light: New incident: ${opts.firstIssue.title}`;
  const blocks = incidentBlocks({
    emoji: "rotating_light",
    status: "New Incident",
    title: opts.firstIssue.title,
    projectName: opts.projectName,
    service: opts.firstIssue.service,
    environment:
      opts.incident.environment ??
      environmentFromResourceAttrs(opts.firstIssue.lastSample?.resourceAttrs),
    buttons: [{ text: "Open in Superlog", url: incidentUrl, actionId: "open_superlog" }],
    incidentId: opts.incident.id,
    showResolveButton: true,
  });
  await postAndRememberIncidentRoot({ incidentId: opts.incident.id, target, text, blocks });
}

async function createIncidentRootInCurrentRoute(
  incident: schema.Incident,
): Promise<{ target: SlackTarget; threadTs: string } | null> {
  const target = await fetchSlackTarget(incident.projectId);
  if (!target) return null;
  const project = await db.query.projects.findFirst({
    where: eq(schema.projects.id, incident.projectId),
  });
  const incidentUrl = `${WEB_ORIGIN}/incidents/${incident.id}`;
  const text = `:rotating_light: Incident: ${incident.title}`;
  const blocks = incidentBlocks({
    emoji: "rotating_light",
    status: "Incident",
    title: incident.title,
    projectName: project?.name ?? incident.projectId,
    service: incident.service,
    environment: incident.environment,
    buttons: [{ text: "Open in Superlog", url: incidentUrl, actionId: "open_superlog" }],
    incidentId: incident.id,
    showResolveButton: true,
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
