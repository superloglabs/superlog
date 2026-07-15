import type {
  CloseIncidentOpenPullRequestsResult,
  CloseIncidentPullRequest,
  IncidentResolutionProof,
} from "@superlog/db";
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

export type ResolvedIncidentResolutionEpoch = {
  isCurrent(): Promise<boolean>;
  reconcileStalePublication(): Promise<void>;
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
  projectRoute: { orgSlug: string; projectSlug: string };
  resolutionEpoch?: ResolvedIncidentResolutionEpoch;
  deps: ResolvedIncidentSideEffectDeps;
}): Promise<CloseIncidentOpenPullRequestsResult> {
  if (opts.resolutionEpoch && !(await opts.resolutionEpoch.isCurrent())) {
    return { closedPullRequestCount: 0, failedPullRequestCount: 0 };
  }
  let closed: CloseIncidentOpenPullRequestsResult;
  try {
    closed = await opts.deps.closeIncidentPullRequests(opts.incident.id);
  } catch (err) {
    log.warn({ err, incident_id: opts.incident.id }, "failed to close incident PRs after resolve");
    closed = { closedPullRequestCount: 0, failedPullRequestCount: 1 };
  }

  if (opts.resolutionEpoch && !(await opts.resolutionEpoch.isCurrent())) {
    return closed;
  }

  const slackRoot = buildResolvedIncidentSlackRoot({
    incident: opts.incident,
    projectName: opts.projectName,
    projectRoute: opts.projectRoute,
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

  if (opts.resolutionEpoch && !(await opts.resolutionEpoch.isCurrent())) {
    await opts.resolutionEpoch.reconcileStalePublication();
  }

  return closed;
}

export async function runResolvedIncidentSideEffectsForIncident(opts: {
  incidentId: string;
  closePullRequest: CloseIncidentPullRequest;
  resolutionProof: IncidentResolutionProof;
  reopenPullRequest: CloseIncidentPullRequest;
}): Promise<CloseIncidentOpenPullRequestsResult | null> {
  const { db, isIncidentResolutionProofCurrent, schema } = await import("@superlog/db");
  const incident = await db.query.incidents.findFirst({
    where: eq(schema.incidents.id, opts.incidentId),
  });
  if (!incident) return null;
  const project = await db.query.projects.findFirst({
    where: eq(schema.projects.id, incident.projectId),
  });
  if (!project) return null;
  const org = await db.query.orgs.findFirst({ where: eq(schema.orgs.id, project.orgId) });
  if (!org) return null;
  const resolutionProof = opts.resolutionProof;
  const deps = createResolvedIncidentSideEffectDeps({
    closePullRequest: opts.closePullRequest,
    resolutionProof,
    reopenPullRequest: opts.reopenPullRequest,
  });
  return runResolvedIncidentSideEffects({
    incident: {
      id: incident.id,
      title: incident.title,
      service: incident.service,
    },
    projectName: project.name,
    projectRoute: { orgSlug: org.slug, projectSlug: project.slug },
    resolutionEpoch: {
      isCurrent: () =>
        isIncidentResolutionProofCurrent({
          incidentId: incident.id,
          resolutionProof,
          database: db,
        }),
      reconcileStalePublication: async () => {
        const current = await db.query.incidents.findFirst({
          where: eq(schema.incidents.id, incident.id),
        });
        if (!current) return;
        const slackRoot = buildIncidentResolutionCompensationSlackRoot({
          incident: current,
          projectName: project.name,
          projectRoute: { orgSlug: org.slug, projectSlug: project.slug },
        });
        await deps.updateSlackRootMessage({
          incident: current,
          text: slackRoot.text,
          blocks: slackRoot.blocks,
        });
      },
    },
    deps,
  });
}

export function buildResolvedIncidentSlackRoot(opts: {
  incident: ResolvedIncidentSideEffectIncident;
  projectName: string;
  projectRoute: { orgSlug: string; projectSlug: string };
}): ResolvedIncidentSlackRoot {
  const origin = WEB_ORIGIN.replace(/\/$/, "");
  const incidentUrl = escapeSlackLinkUrl(
    `${origin}/org/${encodeURIComponent(opts.projectRoute.orgSlug)}/project/${encodeURIComponent(opts.projectRoute.projectSlug)}/incidents/${encodeURIComponent(opts.incident.id)}`,
  );
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

export function buildIncidentResolutionCompensationSlackRoot(opts: {
  incident: ResolvedIncidentSideEffectIncident & { status: string };
  projectName: string;
  projectRoute: { orgSlug: string; projectSlug: string };
}): ResolvedIncidentSlackRoot {
  if (opts.incident.status !== "open") {
    return buildResolvedIncidentSlackRoot(opts);
  }

  const origin = WEB_ORIGIN.replace(/\/$/, "");
  const incidentUrl = escapeSlackLinkUrl(
    `${origin}/org/${encodeURIComponent(opts.projectRoute.orgSlug)}/project/${encodeURIComponent(opts.projectRoute.projectSlug)}/incidents/${encodeURIComponent(opts.incident.id)}`,
  );
  const titleLabel = escapeSlackLinkText(opts.incident.title);
  const lines = [
    ":rotating_light: *Incident reopened*",
    `*<${incidentUrl}|${titleLabel}>*`,
    opts.incident.service
      ? `\`${opts.projectName}\` · \`${opts.incident.service}\``
      : `\`${opts.projectName}\``,
  ];

  return {
    text: `:rotating_light: ${opts.incident.title} - Incident reopened`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Resolve", emoji: true },
            style: "primary",
            action_id: `resolve_incident:${opts.incident.id}`,
          },
        ],
      },
    ],
  };
}

export function createResolvedIncidentSideEffectDeps(opts: {
  closePullRequest: CloseIncidentPullRequest;
  resolutionProof: IncidentResolutionProof;
  reopenPullRequest: CloseIncidentPullRequest;
  updateSlackRootMessage?: ResolvedIncidentSideEffectDeps["updateSlackRootMessage"];
}): ResolvedIncidentSideEffectDeps {
  return {
    closeIncidentPullRequests: async (incidentId) => {
      const { closeIncidentOpenPullRequestsAfterResolution } = await import("@superlog/db");
      return closeIncidentOpenPullRequestsAfterResolution({
        incidentId,
        resolutionProof: opts.resolutionProof,
        closePullRequest: opts.closePullRequest,
        reopenPullRequest: opts.reopenPullRequest,
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
