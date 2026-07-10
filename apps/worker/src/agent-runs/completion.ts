import {
  type AgentRunResult,
  type ResolveIssueOutcome,
  closeIncidentOpenPullRequestsAfterResolution,
  createIncidentLifecycle,
  db,
  schema,
} from "@superlog/db";
import { and, desc, eq } from "drizzle-orm";
import type { AgentRunContext } from "../agent-run-context.js";
import { createAgentRunLifecycle } from "../agent-run.js";
import { closeAgentPullRequestOnGithub, postAgentPrComment } from "../github-app.js";
import { FIXED_IN_CURRENT_CODE_COOLDOWN_MS } from "../incident-cooldown.js";
import {
  completedNoiseReason,
  completedResolutionReason,
  noiseReasonLabel,
  resolutionReasonLabel,
} from "../incident-result-policy.js";
import {
  incidentBlocks,
  postIncidentThreadMessage,
  updateIncidentMainMessage,
} from "../infra/slack/incident-messages.js";
import { logger } from "../logger.js";
import { enqueueAgentRunCompleted } from "../webhooks.js";
import { recordFiledLinearTicket } from "./deliverable-records.js";
import { deliverLinearTicket } from "./linear-delivery.js";
import { isAlertIncident, truncateSlackText } from "./result-metadata.js";

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:5173";
const agentRunLifecycle = createAgentRunLifecycle(db);
const incidentLifecycle = createIncidentLifecycle(db);

// Channel-in = channel-out: when this turn was triggered by a PR comment, post
// the agent's reply back onto the PR (in addition to the Slack incident thread,
// which stays the system of record). The turn's origin is the run's trigger for
// a cold-start follow-up, or the latest human_reply event for a resumed/steered
// session. Best-effort — a failed PR post never blocks completion.
// A GitHub comment/PR URL → (repo, PR number), so the reply can land on the
// PR the human actually wrote on rather than "the incident's latest open PR".
export function parsePrRefFromGithubUrl(
  url: string | null | undefined,
): { repoFullName: string; prNumber: number } | null {
  if (!url) return null;
  const match = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
  if (!match) return null;
  const prNumber = Number(match[2]);
  if (!Number.isInteger(prNumber)) return null;
  return { repoFullName: match[1] as string, prNumber };
}

export async function replyToPrOriginIfNeeded(
  ctx: AgentRunContext,
  replyText: string,
): Promise<void> {
  let isPrOrigin = ctx.agentRun.trigger === "pr_comment";
  // A cold-start pr_comment run has no human_reply event yet — its origin PR
  // lives in the trigger detail. A later human_reply (resumed/steered
  // session) still overrides below, since the latest interaction wins.
  let originUrl: string | null = isPrOrigin
    ? (ctx.agentRun.triggerDetail?.interactions?.find(
        (interaction) => interaction.channel === "pr_comment",
      )?.url ?? null)
    : null;
  const lastReply = await db.query.incidentEvents.findFirst({
    where: and(
      eq(schema.incidentEvents.agentRunId, ctx.agentRun.id),
      eq(schema.incidentEvents.kind, "human_reply"),
    ),
    orderBy: [desc(schema.incidentEvents.createdAt)],
    columns: { detail: true },
  });
  const origin = (
    lastReply?.detail as { origin?: { channel?: string; url?: string | null } } | null
  )?.origin;
  if (origin?.channel === "pr_comment") {
    isPrOrigin = true;
    originUrl = origin.url ?? null;
  } else if (!isPrOrigin) {
    return;
  }
  if (!isPrOrigin) return;

  // Prefer the exact PR the triggering comment was on; an incident can carry
  // several agent PRs. Fall back to the latest open one for legacy events
  // whose origin has no parseable URL.
  const originRef = parsePrRefFromGithubUrl(originUrl);
  const [target] = await db
    .select({
      prNumber: schema.agentPullRequests.prNumber,
      repoFullName: schema.agentPullRequests.repoFullName,
      installationId: schema.githubInstallations.installationId,
    })
    .from(schema.agentPullRequests)
    .innerJoin(
      schema.githubInstallations,
      eq(schema.githubInstallations.id, schema.agentPullRequests.installationId),
    )
    .where(
      originRef
        ? and(
            eq(schema.agentPullRequests.incidentId, ctx.incident.id),
            eq(schema.agentPullRequests.repoFullName, originRef.repoFullName),
            eq(schema.agentPullRequests.prNumber, originRef.prNumber),
          )
        : and(
            eq(schema.agentPullRequests.incidentId, ctx.incident.id),
            eq(schema.agentPullRequests.state, "open"),
          ),
    )
    .orderBy(desc(schema.agentPullRequests.createdAt))
    .limit(1);
  if (!target) return;

  const result = await postAgentPrComment({
    installationId: target.installationId,
    repoFullName: target.repoFullName,
    prNumber: target.prNumber,
    body: replyText,
  });
  if (!result.ok) {
    logger.warn(
      {
        scope: "agent_run",
        agent_run_id: ctx.agentRun.id,
        incident_id: ctx.incident.id,
        repo: target.repoFullName,
        pr_number: target.prNumber,
        error: result.error,
      },
      "failed to post continuation reply to PR",
    );
  }
}

async function closeOpenPullRequestsForResolvedIncident(incidentId: string): Promise<void> {
  await closeIncidentOpenPullRequestsAfterResolution({
    incidentId,
    closePullRequest: (pr) =>
      closeAgentPullRequestOnGithub({
        installationId: pr.githubInstallationId,
        fallbackInstallationIds: pr.fallbackGithubInstallationIds,
        repoFullName: pr.repoFullName,
        prNumber: pr.prNumber,
        prNodeId: pr.prNodeId,
      }),
    onCloseFailure: ({ pr, error }) =>
      logger.warn(
        {
          scope: "incident-resolution-side-effects",
          incident_id: incidentId,
          agent_pr_id: pr.id,
          repo: pr.repoFullName,
          pr_number: pr.prNumber,
          error,
        },
        "failed to close incident PR after resolve",
      ),
  });
}

// A noise verdict resolves the incident plainly and applies the verdict's
// action to the linked issues: silence (default) suppresses future
// occurrences; observe suppresses until the escalation trigger trips.
async function resolveIncidentAsNoise(
  ctx: AgentRunContext,
  result: AgentRunResult,
  noiseReason: schema.IncidentNoiseReason,
): Promise<{ resolved: boolean; resolvedIssueCount: number }> {
  const action = result.noiseClassification?.action ?? null;
  const issueOutcome: ResolveIssueOutcome =
    action?.kind === "observe" ? { kind: "observe", trigger: action.trigger } : { kind: "silence" };
  return incidentLifecycle.resolve({
    incidentId: ctx.incident.id,
    kind: "agent_classification",
    reasonCode: noiseReason,
    reasonText: result.noiseClassification?.evidence?.trim() ?? null,
    agentRunId: ctx.agentRun.id,
    eventSummary: "Incident resolved because the agent run classified it as noise.",
    eventDetail: {
      noiseReason,
      evidence: result.noiseClassification?.evidence ?? null,
      issueOutcome: issueOutcome.kind,
    },
    eventDedupeKey: `incident_resolved:agent_run:${ctx.agentRun.id}:noise`,
    issueOutcome,
  });
}

async function resolveIncidentFromAgentRunConclusion(
  ctx: AgentRunContext,
  result: AgentRunResult,
  reason: schema.IncidentResolutionReason,
): Promise<{ resolved: boolean; resolvedIssueCount: number }> {
  const now = new Date();
  const evidence = result.resolutionClassification?.evidence?.trim() ?? null;
  // For `fixed_in_current_code`, prod will keep producing the same exception
  // until the deploy promotes — start the cooldown. For other resolution
  // reasons, recurrence is real signal, so leave the cooldown cleared so a
  // recurrence triggers a fresh investigation.
  const autoInvestigateSuppressedUntil =
    reason === "fixed_in_current_code"
      ? new Date(now.getTime() + FIXED_IN_CURRENT_CODE_COOLDOWN_MS)
      : null;

  return incidentLifecycle.resolve({
    incidentId: ctx.incident.id,
    kind: "agent_classification",
    reasonCode: reason,
    reasonText: evidence,
    agentRunId: ctx.agentRun.id,
    eventSummary: "Incident resolved because the agent run found it was already resolved.",
    eventDetail: {
      legacyReason: "agent_already_resolved",
      resolutionReason: reason,
      evidence,
    },
    eventDedupeKey: `incident_resolved:agent_run:${ctx.agentRun.id}:already_resolved`,
    resolvedAt: now,
    autoInvestigateSuppressedUntil,
  });
}

// Reason code stored on incidents resolved by the agent's terminal
// resolve_incident call. The human-readable why lives in reasonText.
export const AGENT_RESOLVED_REASON_CODE = "agent_resolved";

// Terminal path for the multi-PR contract: the agent classified every linked
// issue mid-run (silence/observe/resolve — already applied to the issue rows)
// and called resolve_incident. This resolves the incident WITHOUT cascading an
// issue disposition (issueOutcome none), records metadata, and closes any PRs
// the agent left open (it resolved without them, so they're abandoned).
export async function completeWithIncidentResolution(
  ctx: AgentRunContext,
  result: AgentRunResult,
  sessionId: string,
  runtimeMinutes: number,
): Promise<void> {
  const resolution = result.incidentResolution;
  if (!resolution) {
    throw new Error("completeWithIncidentResolution requires result.incidentResolution");
  }
  await agentRunLifecycle.completeWithoutPullRequest({
    id: ctx.agentRun.id,
    currentState: ctx.agentRun.state,
    result,
  });
  const metadataOutcome = await incidentLifecycle.applyAgentRunResult({
    incident: ctx.incident,
    agentRunId: ctx.agentRun.id,
    result,
  });
  if (metadataOutcome.updated) {
    const refreshed = await db.query.incidents.findFirst({
      where: eq(schema.incidents.id, ctx.incident.id),
    });
    if (refreshed) ctx.incident = refreshed;
  }
  await enqueueAgentRunCompleted(ctx.agentRun.id).catch((err) =>
    logger.error(
      {
        scope: "webhooks.enqueue",
        agent_run_id: ctx.agentRun.id,
        err: err instanceof Error ? err.message : String(err),
      },
      "failed to enqueue agent run.completed webhook",
    ),
  );

  const { resolved } = await incidentLifecycle.resolve({
    incidentId: ctx.incident.id,
    kind: "agent_classification",
    reasonCode: AGENT_RESOLVED_REASON_CODE,
    reasonText: resolution.reason,
    agentRunId: ctx.agentRun.id,
    eventSummary: "Incident resolved by the investigating agent.",
    eventDetail: { reason: resolution.reason, evidence: resolution.evidence },
    eventDedupeKey: `incident_resolved:agent_run:${ctx.agentRun.id}:resolve_incident`,
    // Issues were classified one by one during the run; nothing to cascade.
    issueOutcome: { kind: "none" },
  });
  if (resolved) {
    await closeOpenPullRequestsForResolvedIncident(ctx.incident.id);
    const refreshed = await db.query.incidents.findFirst({
      where: eq(schema.incidents.id, ctx.incident.id),
    });
    if (refreshed) ctx.incident = refreshed;
  }

  // Linear ticket: file/update deterministically from the findings, linking
  // the most recent PR when one was opened during the run.
  const latestPr = await db.query.agentPullRequests.findFirst({
    where: eq(schema.agentPullRequests.incidentId, ctx.incident.id),
    orderBy: [desc(schema.agentPullRequests.createdAt)],
    columns: { url: true },
  });
  const deliveredTicket = await deliverLinearTicket(ctx, result, {
    prUrl: latestPr?.url ?? null,
  });
  if (deliveredTicket) {
    await recordFiledLinearTicket(
      ctx,
      {
        id: deliveredTicket.ticketId,
        url: deliveredTicket.url,
        createdByAgent: deliveredTicket.created,
      },
      { identifier: deliveredTicket.identifier },
    );
  }

  logger.info(
    {
      scope: "agent_run",
      agent_run_id: ctx.agentRun.id,
      incident_id: ctx.incident.id,
      session_id: sessionId,
      runtime_minutes: runtimeMinutes,
      resolved,
    },
    "agent run complete (incident resolved by agent)",
  );

  const evidence = resolution.evidence?.trim();
  const lines = [
    `:white_check_mark: Investigation resolved this incident: ${resolution.reason}`,
    result.summary,
  ];
  if (evidence) lines.push(`Evidence: ${truncateSlackText(evidence, 1800)}`);
  await postIncidentThreadMessage(ctx.incident.id, lines.join("\n"));
  const incidentUrl = `${WEB_ORIGIN}/incidents/${ctx.incident.id}`;
  await updateIncidentMainMessage(
    ctx.incident.id,
    `:white_check_mark: ${ctx.incident.title} — Incident resolved`,
    incidentBlocks({
      emoji: "white_check_mark",
      status: "Incident resolved by the agent",
      title: ctx.incident.title,
      tagline: truncateSlackText(result.summary),
      projectName: ctx.project.name,
      service: ctx.incident.service,
      buttons: [{ text: "View agent run", url: incidentUrl, actionId: "view_agent_run" }],
      incidentId: ctx.incident.id,
    }),
  );
  await replyToPrOriginIfNeeded(ctx, result.summary);
}

export async function completeWithoutPullRequest(
  ctx: AgentRunContext,
  result: AgentRunResult,
  sessionId: string,
  runtimeMinutes: number,
): Promise<void> {
  const noiseReason = completedNoiseReason(result);
  const resolutionReason = noiseReason ? null : completedResolutionReason(result);
  // Set once the noise verdict was actually recorded against an open incident
  // (applyAgentRunResult ignores verdicts on already-closed incidents) — the
  // "marked as noise" messaging below must not claim a state change that
  // never happened.
  let noiseApplied = false;
  await agentRunLifecycle.completeWithoutPullRequest({
    id: ctx.agentRun.id,
    currentState: ctx.agentRun.state,
    result,
  });
  const metadataOutcome = await incidentLifecycle.applyAgentRunResult({
    incident: ctx.incident,
    agentRunId: ctx.agentRun.id,
    result,
  });
  if (metadataOutcome.updated) {
    const refreshed = await db.query.incidents.findFirst({
      where: eq(schema.incidents.id, ctx.incident.id),
    });
    if (refreshed) ctx.incident = refreshed;
  }
  await enqueueAgentRunCompleted(ctx.agentRun.id).catch((err) =>
    logger.error(
      {
        scope: "webhooks.enqueue",
        agent_run_id: ctx.agentRun.id,
        err: err instanceof Error ? err.message : String(err),
      },
      "failed to enqueue agent run.completed webhook",
    ),
  );
  // The platform files/updates the Linear ticket deterministically from the
  // run's findings (after the metadata pass, so the ticket carries the
  // agent-proposed title). The agent no longer self-reports ticket ids —
  // except legacy in-flight runs finishing on the old contract, whose
  // self-reported ticket link is preserved below.
  const deliveredTicket = await deliverLinearTicket(ctx, result, { prUrl: null });
  if (deliveredTicket) {
    await recordFiledLinearTicket(
      ctx,
      {
        id: deliveredTicket.ticketId,
        url: deliveredTicket.url,
        createdByAgent: deliveredTicket.created,
      },
      { identifier: deliveredTicket.identifier },
    );
  } else if (result.linearTicket) {
    await recordFiledLinearTicket(ctx, result.linearTicket);
  }
  const ticketDisplay = deliveredTicket
    ? { identifier: deliveredTicket.identifier, url: deliveredTicket.url }
    : result.linearTicket
      ? { identifier: result.linearTicket.id, url: result.linearTicket.url ?? null }
      : null;
  if (resolutionReason) {
    const { resolved } = await resolveIncidentFromAgentRunConclusion(ctx, result, resolutionReason);
    if (resolved) {
      await closeOpenPullRequestsForResolvedIncident(ctx.incident.id);
    }
    const refreshed = await db.query.incidents.findFirst({
      where: eq(schema.incidents.id, ctx.incident.id),
    });
    if (refreshed) ctx.incident = refreshed;
  } else if (noiseReason && metadataOutcome.noiseResolved) {
    noiseApplied = true;
    const { resolved } = await resolveIncidentAsNoise(ctx, result, noiseReason);
    if (resolved) {
      await closeOpenPullRequestsForResolvedIncident(ctx.incident.id);
    }
    const refreshed = await db.query.incidents.findFirst({
      where: eq(schema.incidents.id, ctx.incident.id),
    });
    if (refreshed) ctx.incident = refreshed;
  }
  logger.info(
    {
      scope: "agent_run",
      agent_run_id: ctx.agentRun.id,
      incident_id: ctx.incident.id,
      session_id: sessionId,
      runtime_minutes: runtimeMinutes,
      has_ticket: !!ticketDisplay,
      resolved_by_agent: !!resolutionReason,
    },
    "agent run complete",
  );
  const ticket = ticketDisplay;
  if (noiseReason && noiseApplied) {
    const label = noiseReasonLabel(noiseReason);
    const evidence = result.noiseClassification?.evidence?.trim();
    const target = isAlertIncident(ctx) ? "alert" : "incident";
    const lines = [
      `:no_bell: Investigation confirmed this ${target} is noise (${label}).`,
      result.summary,
    ];
    if (evidence) lines.push(`Evidence: ${truncateSlackText(evidence, 1800)}`);
    await postIncidentThreadMessage(ctx.incident.id, lines.join("\n"));
  } else if (resolutionReason) {
    const label = resolutionReasonLabel(resolutionReason);
    const evidence = result.resolutionClassification?.evidence?.trim();
    const lines = [
      `:white_check_mark: Investigation confirmed this incident is already resolved (${label}).`,
      result.summary,
    ];
    if (evidence) lines.push(`Evidence: ${truncateSlackText(evidence, 1800)}`);
    await postIncidentThreadMessage(ctx.incident.id, lines.join("\n"));
  } else {
    const badge = ticket
      ? `:ticket: Filed ${ticket.identifier}${ticket.url ? `: ${ticket.url}` : ""}`
      : ":memo:";
    await postIncidentThreadMessage(ctx.incident.id, `${badge} ${result.summary}`);
  }
  const incidentUrl = `${WEB_ORIGIN}/incidents/${ctx.incident.id}`;
  const status =
    noiseReason && noiseApplied
      ? `${isAlertIncident(ctx) ? "Alert" : "Incident"} marked as noise - ${noiseReasonLabel(noiseReason)}`
      : resolutionReason
        ? `Incident resolved - ${resolutionReasonLabel(resolutionReason)}`
        : ticket
          ? `Investigation complete · Linear ${ticket.identifier}`
          : "Investigation complete";
  const text =
    noiseReason && noiseApplied
      ? `:no_bell: ${ctx.incident.title} — ${isAlertIncident(ctx) ? "Alert" : "Incident"} marked as noise`
      : resolutionReason
        ? `:white_check_mark: ${ctx.incident.title} — Incident resolved`
        : `:white_check_mark: ${ctx.incident.title} — Investigation complete`;
  await updateIncidentMainMessage(
    ctx.incident.id,
    text,
    incidentBlocks({
      emoji: noiseReason && noiseApplied ? "no_bell" : "white_check_mark",
      status,
      title: ctx.incident.title,
      titleUrl: incidentUrl,
      tagline: truncateSlackText(result.summary),
      projectName: ctx.project.name,
      service: ctx.incident.service,
      buttons: [],
      links: ticket?.url ? [{ text: "View ticket", url: ticket.url }] : [],
      incidentId: ctx.incident.id,
      showFeedbackButtons: true,
    }),
  );
  await replyToPrOriginIfNeeded(ctx, result.summary);
}
