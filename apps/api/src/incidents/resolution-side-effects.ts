import type {
  CloseIncidentOpenPullRequestsResult,
  CloseIncidentPullRequest,
  IncidentResolutionProof,
} from "@superlog/db";
import { and, eq } from "drizzle-orm";
import { logger } from "../logger.js";
import { buildIncidentWebUrl } from "../project-web-route.js";
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
  silencedByClosedPr?: { closedByLogin: string | null };
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
    silencedByClosedPr: opts.silencedByClosedPr,
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
  const { db, incidentHasCurrentSilencedIssues, isIncidentResolutionProofCurrent, schema } =
    await import("@superlog/db");
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
  // A closed-PR resolution silenced the incident's issues (the settled-path
  // default in @superlog/db). Surface that on the root message, attributing
  // the close from the resolution event's recorded actor rather than parsing
  // reason text. Gated on an issue whose *current* incident is this one still
  // being silenced: a re-render after the un-silence click paints the plain
  // resolved copy, and an issue that recurred into a newer incident cannot
  // resurface the silenced variant here (the button could no longer touch it).
  let silencedByClosedPr: { closedByLogin: string | null } | undefined;
  if (incident.resolvedReasonCode === "agent_pr_closed") {
    if (await incidentHasCurrentSilencedIssues(incident.id)) {
      const resolutionEvent = await db.query.incidentEvents.findFirst({
        where: and(
          eq(schema.incidentEvents.incidentId, incident.id),
          eq(schema.incidentEvents.dedupeKey, resolutionProof.eventDedupeKey),
        ),
      });
      const detail = resolutionEvent?.detail as { closedByLogin?: unknown } | null | undefined;
      silencedByClosedPr = {
        closedByLogin: typeof detail?.closedByLogin === "string" ? detail.closedByLogin : null,
      };
    }
  }
  return runResolvedIncidentSideEffects({
    incident: {
      id: incident.id,
      title: incident.title,
      service: incident.service,
    },
    silencedByClosedPr,
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
  // Set when the resolution came from the last agent PR being closed without
  // merge: the resolve cascade silenced the incident's issues, so the root
  // message says so and offers the un-silence action.
  silencedByClosedPr?: { closedByLogin: string | null };
}): ResolvedIncidentSlackRoot {
  const incidentUrl = escapeSlackLinkUrl(
    buildIncidentWebUrl(WEB_ORIGIN, { ...opts.projectRoute, incidentId: opts.incident.id }),
  );
  const titleLabel = escapeSlackLinkText(opts.incident.title);
  const silenced = opts.silencedByClosedPr;
  const lines = [
    silenced
      ? ":no_bell: *Incident resolved — errors silenced*"
      : ":white_check_mark: *Incident resolved*",
    `*<${incidentUrl}|${titleLabel}>*`,
    opts.incident.service
      ? `\`${opts.projectName}\` · \`${opts.incident.service}\``
      : `\`${opts.projectName}\``,
  ];
  if (silenced) {
    const closedBy = silenced.closedByLogin
      ? `PR closed by @${silenced.closedByLogin}`
      : "PR closed";
    lines.push(
      `${closedBy} — this incident and its errors are silenced and will not raise incidents anymore. ` +
        `If you'd like these errors to reopen incidents, click *Do not silence, resolve*.`,
    );
  }
  const elements: unknown[] = [];
  if (silenced) {
    elements.push({
      type: "button",
      text: { type: "plain_text", text: "Do not silence, resolve", emoji: true },
      action_id: `unsilence_resolve:${opts.incident.id}`,
    });
  }
  elements.push(
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
  );
  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
    { type: "actions", elements },
  ];
  return {
    text: silenced
      ? `:no_bell: ${opts.incident.title} - Incident resolved, errors silenced`
      : `:white_check_mark: ${opts.incident.title} - Incident resolved`,
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

  const incidentUrl = escapeSlackLinkUrl(
    buildIncidentWebUrl(WEB_ORIGIN, { ...opts.projectRoute, incidentId: opts.incident.id }),
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
