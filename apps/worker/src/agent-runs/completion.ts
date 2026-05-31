import { type AgentRunResult, createIncidentLifecycle, db, schema } from "@superlog/db";
import { eq } from "drizzle-orm";
import type { AgentRunContext } from "../agent-run-context.js";
import { createAgentRunLifecycle } from "../agent-run.js";
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
import { isAlertIncident, truncateSlackText } from "./result-metadata.js";

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:5173";
const agentRunLifecycle = createAgentRunLifecycle(db);
const incidentLifecycle = createIncidentLifecycle(db);

async function resolveIncidentFromAgentRunConclusion(
  ctx: AgentRunContext,
  result: AgentRunResult,
  reason: schema.IncidentResolutionReason,
): Promise<number> {
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

  const { resolvedIssueCount } = await incidentLifecycle.resolve({
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

  return resolvedIssueCount;
}

export async function completeWithoutPullRequest(
  ctx: AgentRunContext,
  result: AgentRunResult,
  sessionId: string,
  runtimeMinutes: number,
): Promise<void> {
  const noiseReason = completedNoiseReason(result);
  const resolutionReason = noiseReason ? null : completedResolutionReason(result);
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
  await recordFiledLinearTicket(ctx, result.linearTicket);
  if (resolutionReason) {
    await resolveIncidentFromAgentRunConclusion(ctx, result, resolutionReason);
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
      has_ticket: !!result.linearTicket,
      resolved_by_agent: !!resolutionReason,
    },
    "agent run complete",
  );
  const ticket = result.linearTicket;
  if (noiseReason) {
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
    const badge = ticket ? `:ticket: Filed ${ticket.id}: ${ticket.url}` : ":memo:";
    await postIncidentThreadMessage(ctx.incident.id, `${badge} ${result.summary}`);
  }
  const incidentUrl = `${WEB_ORIGIN}/incidents/${ctx.incident.id}`;
  const status = noiseReason
    ? `${isAlertIncident(ctx) ? "Alert" : "Incident"} marked as noise - ${noiseReasonLabel(noiseReason)}`
    : resolutionReason
      ? `Incident resolved - ${resolutionReasonLabel(resolutionReason)}`
      : ticket
        ? `Investigation complete · Linear ${ticket.id}`
        : "Investigation complete";
  const text = noiseReason
    ? `:no_bell: ${ctx.incident.title} — ${isAlertIncident(ctx) ? "Alert" : "Incident"} marked as noise`
    : resolutionReason
      ? `:white_check_mark: ${ctx.incident.title} — Incident resolved`
      : `:white_check_mark: ${ctx.incident.title} — Investigation complete`;
  await updateIncidentMainMessage(
    ctx.incident.id,
    text,
    incidentBlocks({
      emoji: noiseReason ? "no_bell" : "white_check_mark",
      status,
      title: ctx.incident.title,
      tagline: truncateSlackText(result.summary),
      projectName: ctx.project.name,
      service: ctx.incident.service,
      buttons: [
        { text: "View agent run", url: incidentUrl, actionId: "view_agent_run" },
        ...(ticket?.url ? [{ text: "View ticket", url: ticket.url, actionId: "view_ticket" }] : []),
      ],
      incidentId: ctx.incident.id,
    }),
  );
}
