import type { CloseIncidentOpenPullRequestsResult, CloseIncidentPullRequest } from "@superlog/db";
import { and, eq } from "drizzle-orm";
import { logger } from "../logger.js";
import { escapeSlackLinkText, escapeSlackLinkUrl } from "../slack-format.js";

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:5173";

const log = logger.child({ scope: "incident-resolution-side-effects" });

export type ResolvedIncidentSideEffectIncident = {
  id: string;
  title: string;
  service: string | null;
};

export type ResolvedIncidentSlackRoot = {
  text: string;
  blocks: unknown[];
};

export type ResolvedIncidentSideEffectDeps = {
  closeIncidentPullRequests(incidentId: string): Promise<CloseIncidentOpenPullRequestsResult>;
  updateSlackRootMessage(input: {
    incident: ResolvedIncidentSideEffectIncident;
    text: string;
    blocks: unknown[];
  }): Promise<void>;
};

export function shouldRunResolvedIncidentSideEffects(opts: {
  requestedStatus: "open" | "resolved";
  incidentExists: boolean;
}): boolean {
  return opts.incidentExists && opts.requestedStatus === "resolved";
}

export async function runResolvedIncidentSideEffects(opts: {
  incident: ResolvedIncidentSideEffectIncident;
  projectName: string;
  deps: ResolvedIncidentSideEffectDeps;
}): Promise<CloseIncidentOpenPullRequestsResult> {
  let closed: CloseIncidentOpenPullRequestsResult;
  try {
    closed = await opts.deps.closeIncidentPullRequests(opts.incident.id);
  } catch (err) {
    log.warn({ err, incident_id: opts.incident.id }, "failed to close incident PRs after resolve");
    closed = { closedPullRequestCount: 0, failedPullRequestCount: 1 };
  }

  const slackRoot = buildResolvedIncidentSlackRoot({
    incident: opts.incident,
    projectName: opts.projectName,
  });
  try {
    await opts.deps.updateSlackRootMessage({
      incident: opts.incident,
      text: slackRoot.text,
      blocks: slackRoot.blocks,
    });
  } catch (err) {
    log.warn(
      { err, incident_id: opts.incident.id },
      "failed to update resolved incident Slack root",
    );
  }

  return closed;
}

export async function runResolvedIncidentSideEffectsForIncident(opts: {
  incidentId: string;
  closePullRequest: CloseIncidentPullRequest;
}): Promise<CloseIncidentOpenPullRequestsResult | null> {
  const { db, schema } = await import("@superlog/db");
  const incident = await db.query.incidents.findFirst({
    where: eq(schema.incidents.id, opts.incidentId),
  });
  if (!incident) return null;
  const project = await db.query.projects.findFirst({
    where: eq(schema.projects.id, incident.projectId),
  });
  return runResolvedIncidentSideEffects({
    incident: {
      id: incident.id,
      title: incident.title,
      service: incident.service,
    },
    projectName: project?.name ?? incident.projectId,
    deps: createResolvedIncidentSideEffectDeps({
      closePullRequest: opts.closePullRequest,
    }),
  });
}

export function buildResolvedIncidentSlackRoot(opts: {
  incident: ResolvedIncidentSideEffectIncident;
  projectName: string;
}): ResolvedIncidentSlackRoot {
  const incidentUrl = escapeSlackLinkUrl(`${WEB_ORIGIN}/incidents/${opts.incident.id}`);
  const titleLabel = escapeSlackLinkText(opts.incident.title);
  const lines = [
    ":white_check_mark: *Incident resolved*",
    `*<${incidentUrl}|${titleLabel}>*`,
    opts.incident.service
      ? `\`${opts.projectName}\` · \`${opts.incident.service}\``
      : `\`${opts.projectName}\``,
  ];
  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "👍 Helpful", emoji: true },
          action_id: `rate_incident:helpful:${opts.incident.id}`,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "👎 Not helpful", emoji: true },
          action_id: `rate_incident:unhelpful:${opts.incident.id}`,
        },
      ],
    },
  ];
  return {
    text: `:white_check_mark: ${opts.incident.title} - Incident resolved`,
    blocks,
  };
}

export function createResolvedIncidentSideEffectDeps(opts: {
  closePullRequest: CloseIncidentPullRequest;
  updateSlackRootMessage?: ResolvedIncidentSideEffectDeps["updateSlackRootMessage"];
}): ResolvedIncidentSideEffectDeps {
  return {
    closeIncidentPullRequests: async (incidentId) => {
      const { closeIncidentOpenPullRequestsAfterResolution } = await import("@superlog/db");
      return closeIncidentOpenPullRequestsAfterResolution({
        incidentId,
        closePullRequest: opts.closePullRequest,
        onCloseFailure: ({ pr, error }) =>
          log.warn(
            {
              incident_id: incidentId,
              agent_pr_id: pr.id,
              repo: pr.repoFullName,
              pr_number: pr.prNumber,
              error,
            },
            "failed to close incident PR after resolve",
          ),
      });
    },
    updateSlackRootMessage: opts.updateSlackRootMessage ?? updateResolvedIncidentSlackRootMessage,
  };
}

export async function updateResolvedIncidentSlackRootMessage(input: {
  incident: ResolvedIncidentSideEffectIncident;
  text: string;
  blocks: unknown[];
}): Promise<void> {
  const { db, schema } = await import("@superlog/db");
  const row = await db.query.incidents.findFirst({
    where: eq(schema.incidents.id, input.incident.id),
  });
  if (!row?.slackChannelId || !row.slackThreadTs || !row.slackInstallationId) return;

  const installation = await db.query.slackInstallations.findFirst({
    where: and(
      eq(schema.slackInstallations.id, row.slackInstallationId),
      eq(schema.slackInstallations.projectId, row.projectId),
    ),
  });
  if (!installation?.botAccessToken || installation.revokedAt) return;

  try {
    const res = await fetch("https://slack.com/api/chat.update", {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${installation.botAccessToken}`,
      },
      body: JSON.stringify({
        channel: row.slackChannelId,
        ts: row.slackThreadTs,
        text: input.text,
        blocks: input.blocks,
      }),
    });
    const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (!data?.ok) {
      log.warn(
        {
          incident_id: input.incident.id,
          channel: row.slackChannelId,
          error: data?.error ?? `status_${res.status}`,
        },
        "failed to update resolved incident Slack root",
      );
    }
  } catch (err) {
    log.warn({ err, incident_id: input.incident.id }, "resolved incident Slack root update threw");
  }
}
