import {
  type AgentRunResult,
  INBOUND_INTERACTION_EVENT_KINDS,
  type IncidentResolutionProof,
  type ResolveIssueOutcome,
  closeIncidentOpenPullRequestsAfterResolution,
  createIncidentLifecycle,
  db,
  incidentHasCurrentSilencedIssues,
  isIncidentResolutionProofCurrent,
  resolveAgentIncident,
  schema,
} from "@superlog/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { AgentRunContext } from "../agent-run-context.js";
import { createAgentRunLifecycle } from "../agent-run.js";
import {
  closeAgentPullRequestOnGithub,
  postAgentPrComment,
  reopenAgentPullRequestOnGithub,
} from "../github-app.js";
import { FIXED_IN_CURRENT_CODE_COOLDOWN_MS } from "../incident-cooldown.js";
import {
  completedNoiseReason,
  completedResolutionReason,
  noiseReasonLabel,
  resolutionReasonLabel,
} from "../incident-result-policy.js";
import { buildContextIncidentUrl } from "../incident-route.js";
import { postLinearIncidentResponse } from "../infra/linear/agent-session.js";
import {
  incidentBlocks,
  postIncidentThreadMessage,
  updateIncidentMainMessage,
} from "../infra/slack/incident-messages.js";
import { logger } from "../logger.js";
import { enqueueAgentRunCompleted } from "../webhooks.js";
import {
  linearHandoffTerminalOutcome,
  shouldCreateLinearTicketForTerminalOutcome,
  shouldOfferOpenPr,
} from "./completion-policy.js";
import { recordFiledLinearTicket } from "./deliverable-records.js";
import { scheduleLinearHandoff } from "./linear-handoff.js";
import {
  closedElsewhereCopyAfterNoiseRace,
  completionIntendsIncidentClosure,
  incidentAlreadyClosedCompletionCopy,
  legacyResolutionEventDedupeKey,
  mergedPullRequestResolutionCopy,
  planLegacyTerminalResolutionCompletion,
  resolutionCompletionCopy,
  resolutionCompletionResult,
  settledPullRequestResolutionCopy,
  shouldRetireProviderSession,
  shouldUpdateResolutionMainMessage,
} from "./resolution-completion.js";
import { reconcileIncidentResolutionFollowUp } from "./resolution-follow-up.js";
import { isAlertIncident, truncateSlackText } from "./result-metadata.js";
import {
  publishAwaitingEventsUpdateIfCurrent,
  reconcileStaleAgentRunPublication,
} from "./status.js";

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:5173";
const agentRunLifecycle = createAgentRunLifecycle(db);
const incidentLifecycle = createIncidentLifecycle(db);

async function refreshIncidentAndRetireSessionIfClosed(
  ctx: AgentRunContext,
  sessionId: string | null,
): Promise<void> {
  const refreshed = await db.query.incidents.findFirst({
    where: eq(schema.incidents.id, ctx.incident.id),
  });
  if (refreshed) ctx.incident = refreshed;
  if (!sessionId || !shouldRetireProviderSession(ctx.incident.status)) return;
  await agentRunLifecycle.recordSessionTerminationPending({
    id: ctx.agentRun.id,
    providerSessionId: sessionId,
  });
}

// Channel-in = channel-out: when this turn was triggered by a PR comment, post
// the agent's reply back onto the PR (in addition to the Slack incident thread,
// which stays the system of record). The turn's origin is the run's trigger for
// a cold-start follow-up, or the latest inbound interaction event for a
// resumed/steered session. Best-effort — a failed PR post never blocks completion.
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
  // A cold-start pr_comment run has no pending interaction event yet — its
  // origin PR lives in the trigger detail. A later resumed/steered interaction
  // still overrides below, since the latest interaction wins.
  let originUrl: string | null = isPrOrigin
    ? (ctx.agentRun.triggerDetail?.interactions?.find(
        (interaction) => interaction.channel === "pr_comment",
      )?.url ?? null)
    : null;
  const lastReply = await db.query.incidentEvents.findFirst({
    where: and(
      eq(schema.incidentEvents.agentRunId, ctx.agentRun.id),
      inArray(schema.incidentEvents.kind, [...INBOUND_INTERACTION_EVENT_KINDS]),
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

export async function closeOpenPullRequestsForResolvedIncident(
  incidentId: string,
  resolutionProof?: IncidentResolutionProof,
): Promise<void> {
  await closeIncidentOpenPullRequestsAfterResolution({
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
    reopenPullRequest: resolutionProof
      ? (pr) =>
          reopenAgentPullRequestOnGithub({
            installationId: pr.githubInstallationId,
            fallbackInstallationIds: pr.fallbackGithubInstallationIds,
            repoFullName: pr.repoFullName,
            prNumber: pr.prNumber,
            prNodeId: pr.prNodeId,
          })
      : undefined,
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
) {
  const action = result.noiseClassification?.action ?? null;
  const issueOutcome: ResolveIssueOutcome =
    action?.kind === "observe" ? { kind: "observe", trigger: action.trigger } : { kind: "silence" };
  const eventDedupeKey = legacyResolutionEventDedupeKey(ctx.agentRun.id, "noise");
  const resolution = await resolveAgentIncident(db, {
    incidentId: ctx.incident.id,
    kind: "agent_classification",
    reasonCode: noiseReason,
    reasonText: result.noiseClassification?.evidence?.trim() ?? null,
    agentRunId: ctx.agentRun.id,
    resolvingAgentRunId: ctx.agentRun.id,
    eventSummary: "Incident resolved because the agent run classified it as noise.",
    eventDetail: {
      noiseReason,
      evidence: result.noiseClassification?.evidence ?? null,
      issueOutcome: issueOutcome.kind,
    },
    eventDedupeKey,
    issueOutcome,
    agentRunResult: result,
  });
  return {
    ...resolution,
    resolutionProof: { agentRunId: ctx.agentRun.id, eventDedupeKey },
  };
}

async function resolveIncidentFromAgentRunConclusion(
  ctx: AgentRunContext,
  result: AgentRunResult,
  reason: schema.IncidentResolutionReason,
) {
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

  const eventDedupeKey = legacyResolutionEventDedupeKey(ctx.agentRun.id, "already_resolved");
  const resolution = await resolveAgentIncident(db, {
    incidentId: ctx.incident.id,
    kind: "agent_classification",
    reasonCode: reason,
    reasonText: evidence,
    agentRunId: ctx.agentRun.id,
    resolvingAgentRunId: ctx.agentRun.id,
    eventSummary: "Incident resolved because the agent run found it was already resolved.",
    eventDetail: {
      legacyReason: "agent_already_resolved",
      resolutionReason: reason,
      evidence,
    },
    eventDedupeKey,
    resolvedAt: now,
    autoInvestigateSuppressedUntil,
    agentRunResult: result,
  });
  return {
    ...resolution,
    resolutionProof: { agentRunId: ctx.agentRun.id, eventDedupeKey },
  };
}

// Reason code stored on incidents resolved by the agent's terminal
// resolve_incident call. The human-readable why lives in reasonText.
export const AGENT_RESOLVED_REASON_CODE = "agent_resolved";

// Terminal resolve completion: dispatch attempted every Issue outcome and the
// Incident resolution in one transaction. Its run-scoped lifecycle event is
// the proof that this run won the race; if another path closed the Incident
// first, persist only this run's findings. Either way, reconcile and close any
// PRs the now-resolved Incident left open.
export async function completeWithIncidentResolution(
  ctx: AgentRunContext,
  result: AgentRunResult,
  sessionId: string,
  runtimeMinutes: number,
): Promise<boolean> {
  const resolution = result.incidentResolution;
  if (!resolution) {
    throw new Error("completeWithIncidentResolution requires result.incidentResolution");
  }
  const resolutionEventDedupeKey = result.incidentResolutionEventDedupeKey;
  const committedResolutionEvent = resolutionEventDedupeKey
    ? await db.query.incidentEvents.findFirst({
        where: and(
          eq(schema.incidentEvents.incidentId, ctx.incident.id),
          eq(schema.incidentEvents.agentRunId, ctx.agentRun.id),
          eq(schema.incidentEvents.kind, "incident_resolved"),
          eq(schema.incidentEvents.dedupeKey, resolutionEventDedupeKey),
        ),
        columns: { id: true },
      })
    : null;
  const resolutionCommittedByRun = Boolean(committedResolutionEvent);
  const resolutionProof: IncidentResolutionProof | null =
    committedResolutionEvent && resolutionEventDedupeKey
      ? { agentRunId: ctx.agentRun.id, eventDedupeKey: resolutionEventDedupeKey }
      : null;
  const completionResult = resolutionCompletionResult(result, resolutionCommittedByRun);
  const copy = resolutionCompletionCopy(resolutionCommittedByRun, resolution.reason);
  const completed = await agentRunLifecycle.completeWithoutPullRequest({
    id: ctx.agentRun.id,
    currentState: ctx.agentRun.state,
    result: completionResult,
    providerSessionIdToTerminate: sessionId,
  });
  if (!completed) return false;
  // A current resolution is closed, so open-only metadata application would
  // be a no-op. If the Incident was manually reopened, applying this old
  // snapshot would instead overwrite the new epoch's findings; never do that
  // from delayed terminal reconciliation.
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

  const isCurrentResolution = resolutionProof
    ? () =>
        isIncidentResolutionProofCurrent({
          incidentId: ctx.incident.id,
          resolutionProof,
        })
    : async () => {
        const current = await db.query.incidents.findFirst({
          where: eq(schema.incidents.id, ctx.incident.id),
          columns: { status: true },
        });
        return current ? shouldRetireProviderSession(current.status) : false;
      };
  const publication = await reconcileIncidentResolutionFollowUp({
    isCurrentResolution,
    closePullRequests: () =>
      resolutionProof
        ? closeOpenPullRequestsForResolvedIncident(ctx.incident.id, resolutionProof)
        : Promise.resolve(),
    publish: async () => {
      await refreshIncidentAndRetireSessionIfClosed(ctx, sessionId);
      const resolved = ctx.incident.status === "resolved";

      // Linear ticket: file/update deterministically from the findings. The
      // reconciliation boundary links every PR recorded for the incident and
      // remains pending when either provider is temporarily unavailable.
      const shouldCreateTicket = shouldCreateLinearTicketForTerminalOutcome(
        "resolve_incident",
        ctx.createLinearTicketOnResolve,
      );
      const deliveredTicket = shouldCreateTicket
        ? await scheduleLinearHandoff(ctx, completionResult, "resolve_incident")
        : null;

      logger.info(
        {
          scope: "agent_run",
          agent_run_id: ctx.agentRun.id,
          incident_id: ctx.incident.id,
          session_id: sessionId,
          runtime_minutes: runtimeMinutes,
          resolved,
          resolution_committed_by_run: resolutionCommittedByRun,
        },
        copy.logMessage,
      );

      const evidence = resolution.evidence?.trim();
      const lines = [copy.threadLead, completionResult.summary];
      if (resolutionCommittedByRun && evidence) {
        lines.push(`Evidence: ${truncateSlackText(evidence, 1800)}`);
      }
      if (deliveredTicket?.url) {
        lines.push(`Linear: <${deliveredTicket.url}|${deliveredTicket.identifier}>`);
      }
      await postIncidentThreadMessage(ctx.incident.id, lines.join("\n"));
      if (shouldUpdateResolutionMainMessage(resolutionCommittedByRun)) {
        const incidentUrl = buildContextIncidentUrl(WEB_ORIGIN, ctx);
        await updateIncidentMainMessage(
          ctx.incident.id,
          `:white_check_mark: ${ctx.incident.title} — Incident resolved`,
          incidentBlocks({
            emoji: "white_check_mark",
            status: copy.status,
            title: ctx.incident.title,
            tagline: truncateSlackText(completionResult.summary),
            service: ctx.incident.service,
            buttons: [{ text: "View incident", url: incidentUrl, actionId: "view_incident" }],
            links: deliveredTicket?.url ? [{ text: "View ticket", url: deliveredTicket.url }] : [],
            incidentId: ctx.incident.id,
          }),
        );
      }
      await replyToPrOriginIfNeeded(ctx, completionResult.summary);
      await postLinearIncidentResponse(ctx.incident.id, completionResult.summary);
    },
    reconcileStalePublication: () => reconcileStaleAgentRunPublication(ctx),
  });
  await refreshIncidentAndRetireSessionIfClosed(ctx, sessionId);
  if (publication !== "published") {
    logger.info(
      {
        scope: "agent_run.completion",
        agent_run_id: ctx.agentRun.id,
        incident_id: ctx.incident.id,
        publication,
      },
      "suppressed stale incident-resolution provider update",
    );
  }
  return true;
}

export async function completeWithoutPullRequest(
  ctx: AgentRunContext,
  result: AgentRunResult,
  sessionId: string | null,
  runtimeMinutes: number,
  opts?: {
    // A deterministic resolution can atomically complete a parked/resuming
    // run before provider publication starts. Reuse the same completion
    // effects only after verifying that governed transition committed.
    runCompletion?: "already_committed_by_resolution";
    incidentOutcome?:
      | {
          kind: "all_pull_requests_merged";
          prNumber: number;
          repoFullName: string;
          resolutionProof: IncidentResolutionProof;
        }
      | {
          kind: "all_pull_requests_settled";
          prNumber: number;
          repoFullName: string;
          settledState: "merged" | "closed";
          resolutionProof: IncidentResolutionProof;
        }
      | { kind: "incident_already_closed" };
  },
): Promise<boolean> {
  const noiseReason = completedNoiseReason(result);
  const resolutionReason = noiseReason ? null : completedResolutionReason(result);
  // The settled outcome only says which PR event triggered the resolve. Read
  // whether the committed cascade actually silenced issues from the database:
  // a close with a merged sibling resolves as agent_pr_merged with the plain
  // resolve cascade, and must not render silenced copy or a no-op un-silence
  // button.
  const settledClosedSilenced =
    opts?.incidentOutcome?.kind === "all_pull_requests_settled" &&
    opts.incidentOutcome.settledState === "closed" &&
    (await incidentHasCurrentSilencedIssues(ctx.incident.id));
  const mergedResolutionCopy =
    opts?.incidentOutcome?.kind === "all_pull_requests_merged"
      ? mergedPullRequestResolutionCopy(opts.incidentOutcome)
      : opts?.incidentOutcome?.kind === "all_pull_requests_settled"
        ? settledPullRequestResolutionCopy({
            ...opts.incidentOutcome,
            silenced: settledClosedSilenced,
          })
        : null;
  const alreadyClosedCopy =
    opts?.incidentOutcome?.kind === "incident_already_closed"
      ? incidentAlreadyClosedCompletionCopy()
      : null;
  let closedElsewhereCopy = alreadyClosedCopy;
  let resolutionProof =
    opts?.incidentOutcome?.kind === "all_pull_requests_merged" ||
    opts?.incidentOutcome?.kind === "all_pull_requests_settled"
      ? opts.incidentOutcome.resolutionProof
      : null;
  let noiseApplied = false;
  // Legacy pre-cutover snapshots encoded terminal intent in their result
  // instead of dispatching resolve_incident. Run the same aggregate guard as
  // the terminal tool before completing the AgentRun: otherwise completion
  // would erase the only active-run proof the guard needs.
  const legacyResolution = resolutionReason
    ? await resolveIncidentFromAgentRunConclusion(ctx, result, resolutionReason)
    : noiseReason
      ? await resolveIncidentAsNoise(ctx, result, noiseReason)
      : null;
  const legacyCompletion = legacyResolution
    ? planLegacyTerminalResolutionCompletion(result, legacyResolution.disposition)
    : null;
  const completionResult = legacyCompletion?.result ?? result;
  if (legacyResolution?.disposition === "resolved") {
    resolutionProof = legacyResolution.resolutionProof;
    noiseApplied = noiseReason !== null;
  } else if (legacyResolution?.disposition === "incident_not_open") {
    closedElsewhereCopy = incidentAlreadyClosedCompletionCopy();
  }
  const intendsIncidentClosure = completionIntendsIncidentClosure({
    hasIncidentOutcome: Boolean(opts?.incidentOutcome),
    noiseReason,
    resolutionReason,
  });
  const completed =
    opts?.runCompletion === "already_committed_by_resolution"
      ? Boolean(
          await db.query.agentRuns.findFirst({
            where: and(
              eq(schema.agentRuns.id, ctx.agentRun.id),
              eq(schema.agentRuns.state, "complete"),
            ),
            columns: { id: true },
          }),
        )
      : await agentRunLifecycle.completeWithoutPullRequest({
          id: ctx.agentRun.id,
          currentState: ctx.agentRun.state,
          result: completionResult,
          ...((legacyCompletion?.shouldTerminateSession ?? intendsIncidentClosure) && sessionId
            ? { providerSessionIdToTerminate: sessionId }
            : {}),
        });
  if (!completed) return false;
  // An obsolete run may be delayed from the previous resolution epoch. Its
  // findings are stale too, not just its terminal verdict, so never flatten
  // any part of that snapshot onto the reopened Incident.
  const metadataOutcome =
    opts?.runCompletion === "already_committed_by_resolution" ||
    legacyResolution?.disposition === "agent_run_not_current" ||
    legacyResolution?.disposition === "resolution_event_already_consumed"
      ? { updated: false }
      : await incidentLifecycle.applyAgentRunResult({
          incident: ctx.incident,
          agentRunId: ctx.agentRun.id,
          result: completionResult,
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
  const isPlainOpenCompletion =
    !resolutionReason && !noiseReason && !mergedResolutionCopy && !alreadyClosedCopy;
  if (isPlainOpenCompletion) {
    const publication = await publishAwaitingEventsUpdateIfCurrent({
      isCurrent: () =>
        agentRunLifecycle.canPublishStatusUpdate({
          id: ctx.agentRun.id,
          incidentId: ctx.incident.id,
          state: "complete",
        }),
      publish: async () => {
        const terminalOutcome = linearHandoffTerminalOutcome(completionResult);
        const explicitLinearHandoff = terminalOutcome === "create_linear_issue";
        const shouldCreateTicket = shouldCreateLinearTicketForTerminalOutcome(
          terminalOutcome,
          false,
        );
        if (explicitLinearHandoff) {
          logger.info(
            {
              scope: "agent_run.linear_handoff",
              agent_run_id: ctx.agentRun.id,
              incident_id: ctx.incident.id,
              terminal_outcome: terminalOutcome,
            },
            "scheduling explicit Linear handoff",
          );
        }
        let deliveredTicket = null;
        try {
          deliveredTicket = shouldCreateTicket
            ? await scheduleLinearHandoff(
                ctx,
                completionResult,
                completionResult.completionKind ?? "complete_without_pr",
              )
            : null;
        } catch (err) {
          if (explicitLinearHandoff) {
            logger.error(
              {
                scope: "agent_run.linear_handoff",
                agent_run_id: ctx.agentRun.id,
                incident_id: ctx.incident.id,
                terminal_outcome: terminalOutcome,
                err,
              },
              "explicit Linear handoff failed",
            );
          }
          throw err;
        }
        if (!deliveredTicket && completionResult.linearTicket) {
          await recordFiledLinearTicket(ctx, completionResult.linearTicket);
        }
        const ticket = deliveredTicket
          ? { identifier: deliveredTicket.identifier, url: deliveredTicket.url }
          : completionResult.linearTicket
            ? {
                identifier: completionResult.linearTicket.id,
                url: completionResult.linearTicket.url ?? null,
              }
            : null;
        if (explicitLinearHandoff && !ticket) {
          logger.error(
            {
              scope: "agent_run.linear_handoff",
              agent_run_id: ctx.agentRun.id,
              incident_id: ctx.incident.id,
              terminal_outcome: terminalOutcome,
            },
            "explicit Linear handoff returned without a ticket",
          );
        }
        logger.info(
          {
            scope: "agent_run",
            agent_run_id: ctx.agentRun.id,
            incident_id: ctx.incident.id,
            session_id: sessionId,
            runtime_minutes: runtimeMinutes,
            has_ticket: !!ticket,
          },
          "agent run complete",
        );
        const badge = ticket
          ? `:ticket: Filed ${ticket.identifier}${ticket.url ? `: ${ticket.url}` : ""}`
          : ":memo:";
        await postIncidentThreadMessage(ctx.incident.id, `${badge} ${completionResult.summary}`);
        const incidentUrl = buildContextIncidentUrl(WEB_ORIGIN, ctx);
        await updateIncidentMainMessage(
          ctx.incident.id,
          `:white_check_mark: ${ctx.incident.title} — Investigation complete`,
          incidentBlocks({
            emoji: "white_check_mark",
            status: ticket
              ? `Investigation complete · Linear ${ticket.identifier}`
              : "Investigation complete",
            title: ctx.incident.title,
            titleUrl: incidentUrl,
            tagline: truncateSlackText(completionResult.summary),
            service: ctx.incident.service,
            buttons: [],
            links: ticket?.url ? [{ text: "View ticket", url: ticket.url }] : [],
            incidentId: ctx.incident.id,
            showOpenPrButton: shouldOfferOpenPr({
              completionKind: completionResult.completionKind,
              prPolicy: ctx.prPolicy,
              githubConnected: ctx.githubInstalls.length > 0,
            }),
            showFeedbackButtons: true,
          }),
        );
        await replyToPrOriginIfNeeded(ctx, completionResult.summary);
        await postLinearIncidentResponse(ctx.incident.id, completionResult.summary);
      },
      reconcileStalePublication: () => reconcileStaleAgentRunPublication(ctx),
    });
    if (publication !== "published") {
      logger.info(
        {
          scope: "agent_run.completion",
          agent_run_id: ctx.agentRun.id,
          incident_id: ctx.incident.id,
          publication,
        },
        "suppressed stale investigation-complete provider update",
      );
    }
    return true;
  }
  await refreshIncidentAndRetireSessionIfClosed(ctx, sessionId);
  closedElsewhereCopy ??= closedElsewhereCopyAfterNoiseRace({
    noiseReason,
    noiseApplied,
    incidentStatus: ctx.incident.status,
  });
  const publish = async (): Promise<void> => {
    // The platform files/updates the Linear ticket deterministically from the
    // run's findings. Keep this provider mutation inside the same epoch guard
    // as Slack and Linear response copy so a reopened Incident cannot receive
    // stale terminal follow-ups from a delayed completion snapshot.
    const deliveredTicket = await scheduleLinearHandoff(
      ctx,
      completionResult,
      completionResult.completionKind ?? "complete_without_pr",
    );
    if (!deliveredTicket && completionResult.linearTicket) {
      await recordFiledLinearTicket(ctx, completionResult.linearTicket);
    }
    const ticket = deliveredTicket
      ? { identifier: deliveredTicket.identifier, url: deliveredTicket.url }
      : completionResult.linearTicket
        ? {
            identifier: completionResult.linearTicket.id,
            url: completionResult.linearTicket.url ?? null,
          }
        : null;
    logger.info(
      {
        scope: "agent_run",
        agent_run_id: ctx.agentRun.id,
        incident_id: ctx.incident.id,
        session_id: sessionId,
        runtime_minutes: runtimeMinutes,
        has_ticket: !!ticket,
        resolved_by_agent: !!resolutionReason,
        resolved_by_pr_merge: !!mergedResolutionCopy,
        incident_already_closed: !!closedElsewhereCopy,
      },
      closedElsewhereCopy?.logMessage ?? "agent run complete",
    );
    if (mergedResolutionCopy) {
      const lines = [mergedResolutionCopy.threadLead, completionResult.summary];
      if (ticket) {
        lines.push(
          ticket.url
            ? `Linear: <${ticket.url}|${ticket.identifier}>`
            : `Linear: ${ticket.identifier}`,
        );
      }
      await postIncidentThreadMessage(ctx.incident.id, lines.join("\n"));
    } else if (closedElsewhereCopy) {
      const lines = [closedElsewhereCopy.threadLead, completionResult.summary];
      if (ticket) {
        lines.push(
          ticket.url
            ? `Linear: <${ticket.url}|${ticket.identifier}>`
            : `Linear: ${ticket.identifier}`,
        );
      }
      await postIncidentThreadMessage(ctx.incident.id, lines.join("\n"));
    } else if (noiseReason && noiseApplied) {
      const label = noiseReasonLabel(noiseReason);
      const evidence = completionResult.noiseClassification?.evidence?.trim();
      const target = isAlertIncident(ctx) ? "alert" : "incident";
      const lines = [
        `:no_bell: Investigation confirmed this ${target} is noise (${label}).`,
        completionResult.summary,
      ];
      if (evidence) lines.push(`Evidence: ${truncateSlackText(evidence, 1800)}`);
      if (ticket) {
        lines.push(
          ticket.url
            ? `Linear: <${ticket.url}|${ticket.identifier}>`
            : `Linear: ${ticket.identifier}`,
        );
      }
      await postIncidentThreadMessage(ctx.incident.id, lines.join("\n"));
    } else if (resolutionReason) {
      const label = resolutionReasonLabel(resolutionReason);
      const evidence = completionResult.resolutionClassification?.evidence?.trim();
      const lines = [
        `:white_check_mark: Investigation confirmed this incident is already resolved (${label}).`,
        completionResult.summary,
      ];
      if (evidence) lines.push(`Evidence: ${truncateSlackText(evidence, 1800)}`);
      if (ticket) {
        lines.push(
          ticket.url
            ? `Linear: <${ticket.url}|${ticket.identifier}>`
            : `Linear: ${ticket.identifier}`,
        );
      }
      await postIncidentThreadMessage(ctx.incident.id, lines.join("\n"));
    } else {
      const badge = ticket
        ? `:ticket: Filed ${ticket.identifier}${ticket.url ? `: ${ticket.url}` : ""}`
        : ":memo:";
      await postIncidentThreadMessage(ctx.incident.id, `${badge} ${completionResult.summary}`);
    }
    if (closedElsewhereCopy?.updateMainMessage !== false) {
      const incidentUrl = buildContextIncidentUrl(WEB_ORIGIN, ctx);
      const status = mergedResolutionCopy
        ? mergedResolutionCopy.status
        : noiseReason && noiseApplied
          ? `${isAlertIncident(ctx) ? "Alert" : "Incident"} marked as noise - ${noiseReasonLabel(noiseReason)}`
          : resolutionReason
            ? `Incident resolved - ${resolutionReasonLabel(resolutionReason)}`
            : ticket
              ? `Investigation complete · Linear ${ticket.identifier}`
              : "Investigation complete";
      const text = mergedResolutionCopy
        ? `:${settledClosedSilenced ? "no_bell" : "white_check_mark"}: ${ctx.incident.title} — ${mergedResolutionCopy.mainTextSuffix}`
        : noiseReason && noiseApplied
          ? `:no_bell: ${ctx.incident.title} — ${isAlertIncident(ctx) ? "Alert" : "Incident"} marked as noise`
          : resolutionReason
            ? `:white_check_mark: ${ctx.incident.title} — Incident resolved`
            : `:white_check_mark: ${ctx.incident.title} — Investigation complete`;
      await updateIncidentMainMessage(
        ctx.incident.id,
        text,
        incidentBlocks({
          emoji:
            (noiseReason && noiseApplied) || settledClosedSilenced ? "no_bell" : "white_check_mark",
          status,
          title: ctx.incident.title,
          titleUrl: incidentUrl,
          tagline: truncateSlackText(completionResult.summary),
          service: ctx.incident.service,
          buttons: [],
          links: ticket?.url ? [{ text: "View ticket", url: ticket.url }] : [],
          incidentId: ctx.incident.id,
          showOpenPrButton: shouldOfferOpenPr({
            completionKind: completionResult.completionKind,
            prPolicy: ctx.prPolicy,
            githubConnected: ctx.githubInstalls.length > 0,
          }),
          showFeedbackButtons: true,
          showUnsilenceButton: settledClosedSilenced,
        }),
      );
    }
    await replyToPrOriginIfNeeded(ctx, completionResult.summary);
    await postLinearIncidentResponse(ctx.incident.id, completionResult.summary);
  };

  const publication = resolutionProof
    ? await reconcileIncidentResolutionFollowUp({
        isCurrentResolution: () =>
          isIncidentResolutionProofCurrent({
            incidentId: ctx.incident.id,
            resolutionProof,
          }),
        closePullRequests: () =>
          closeOpenPullRequestsForResolvedIncident(ctx.incident.id, resolutionProof),
        publish,
        reconcileStalePublication: () => reconcileStaleAgentRunPublication(ctx),
      })
    : await publishAwaitingEventsUpdateIfCurrent({
        isCurrent: async () => {
          const [canPublish, incident] = await Promise.all([
            agentRunLifecycle.canPublishStatusUpdate({
              id: ctx.agentRun.id,
              incidentId: ctx.incident.id,
              state: "complete",
            }),
            db.query.incidents.findFirst({
              where: eq(schema.incidents.id, ctx.incident.id),
              columns: { status: true },
            }),
          ]);
          return canPublish && incident !== undefined && incident.status !== "open";
        },
        publish,
        reconcileStalePublication: () => reconcileStaleAgentRunPublication(ctx),
      });
  if (publication !== "published") {
    logger.info(
      {
        scope: "agent_run.completion",
        agent_run_id: ctx.agentRun.id,
        incident_id: ctx.incident.id,
        publication,
      },
      "suppressed stale terminal completion provider update",
    );
  }
  return true;
}
