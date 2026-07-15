import {
  type AgentRunExternalCause,
  type AgentRunResult,
  db,
  enqueueAgentRunAwaitingInput,
  enqueueAgentRunFailed,
  schema,
} from "@superlog/db";
import type { AgentRunContext } from "../agent-run-context.js";
import {
  type AgentRunLifecycle,
  type PauseForEventsOutcome,
  createAgentRunLifecycle,
} from "../agent-run.js";
import { buildContextIncidentUrl } from "../incident-route.js";
import {
  postLinearIncidentElicitation,
  postLinearIncidentError,
  postLinearIncidentResponse,
} from "../infra/linear/agent-session.js";
import {
  incidentBlocks,
  postIncidentThreadMessage,
  updateIncidentMainMessage,
} from "../infra/slack/incident-messages.js";
import { logger } from "../logger.js";
import { applyIncidentMetadataFromResult } from "./result-metadata.js";

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:5173";
const agentRunLifecycle = createAgentRunLifecycle(db);

export type ConditionalAgentRunStatusDeps = {
  lifecycle: Pick<
    AgentRunLifecycle,
    "fail" | "pauseForHuman" | "blockForGithub" | "canPublishStatusUpdate"
  >;
  enqueueAgentRunFailed: typeof enqueueAgentRunFailed;
  enqueueAgentRunAwaitingInput: typeof enqueueAgentRunAwaitingInput;
  postIncidentThreadMessage: typeof postIncidentThreadMessage;
  postLinearIncidentError: typeof postLinearIncidentError;
  postLinearIncidentElicitation: typeof postLinearIncidentElicitation;
  updateIncidentMainMessage: typeof updateIncidentMainMessage;
  applyIncidentMetadata(ctx: AgentRunContext, result: AgentRunResult): Promise<void>;
  reconcileStalePublication(ctx: AgentRunContext): Promise<void>;
  logError(bindings: Record<string, unknown>, message: string): void;
};

const defaultConditionalAgentRunStatusDeps: ConditionalAgentRunStatusDeps = {
  lifecycle: agentRunLifecycle,
  enqueueAgentRunFailed,
  enqueueAgentRunAwaitingInput,
  postIncidentThreadMessage,
  postLinearIncidentError,
  postLinearIncidentElicitation,
  updateIncidentMainMessage,
  applyIncidentMetadata: applyAndRefreshIncidentMetadata,
  reconcileStalePublication: reconcileStaleAgentRunPublication,
  logError(bindings, message) {
    logger.error(bindings, message);
  },
};

async function applyAndRefreshIncidentMetadata(
  ctx: AgentRunContext,
  result: AgentRunResult,
): Promise<void> {
  if (!(await applyIncidentMetadataFromResult(ctx, result))) return;
  const refreshed = await db.query.incidents.findFirst({
    where: (incidents, { eq }) => eq(incidents.id, ctx.incident.id),
  });
  if (refreshed) ctx.incident = refreshed;
}

async function publishStatusIfCurrent(
  ctx: AgentRunContext,
  state: schema.AgentRun["state"],
  deps: ConditionalAgentRunStatusDeps,
  publish: () => Promise<void>,
): Promise<boolean> {
  const publication = await publishAwaitingEventsUpdateIfCurrent({
    isCurrent: () =>
      deps.lifecycle.canPublishStatusUpdate({
        id: ctx.agentRun.id,
        incidentId: ctx.incident.id,
        state,
      }),
    publish,
    reconcileStalePublication: () => deps.reconcileStalePublication(ctx),
  });
  return publication === "published";
}

// How much wall-clock slack we give a run beyond its provider-active budget
// before we give up. The provider-side budget (snapshot.activeSeconds) is the
// primary check, but Anthropic reports `active_seconds: null` for idle
// sessions, so it never trips for runs that go idle waiting on an
// unacknowledged custom_tool_use. Wall-clock catches those.
export const WALL_CLOCK_MULTIPLIER = 4;

export function exceededWallClockBudget(opts: {
  startedAt: Date | null;
  now: Date;
  maxRuntimeMinutes: number;
  // Total seconds the run has spent parked in `awaiting_human`. This time is
  // excluded from the budget: a run waiting on a human reply isn't stuck, and
  // a human can legitimately take hours to answer. Without this a run that
  // parked on `ask_human` gets reaped the moment it resumes, discarding a
  // finished investigation (prod incident 2026-07-09).
  awaitingHumanSeconds?: number;
}): boolean {
  if (!opts.startedAt) return false;
  const parkedMs = Math.max(0, opts.awaitingHumanSeconds ?? 0) * 1_000;
  const ageMs = opts.now.getTime() - opts.startedAt.getTime() - parkedMs;
  const budgetMs = WALL_CLOCK_MULTIPLIER * opts.maxRuntimeMinutes * 60_000;
  return ageMs > budgetMs;
}

// Wall-clock seconds a run spent parked in `awaiting_human` *within its
// wall-clock measurement window* `[startedAt, now]`, derived from lifecycle
// events. A managed-session pause (`pauseForHuman` from `running`) emits an
// `awaiting_human` event and the matching `resumeRunning` emits `resumed`; we
// pair each such open→close and sum the gaps, clamped to the window.
//
// Two things are deliberately excluded, both because the exclusion must never
// exceed the age it's subtracted from (`now - startedAt`), or the wall-clock
// backstop silently disables itself:
//   - Parks before `startedAt` — a `repo_discovery` pause happens before the
//     managed session (and `startedAt`) exists, so its time was never part of
//     the age. Clamping to the window drops it.
//   - A dangling `awaiting_human` with no matching `resumed`. The pre-session
//     resume path (`requeueAfterHumanReply`) requeues *without* a `resumed`
//     event, so an unclosed park is that repo-discovery pause — already over,
//     its end untracked — not an active wait. Only closed intervals count.
// Nested/duplicate `awaiting_human` events collapse to the earliest park start.
export function awaitingHumanSecondsFromEvents(opts: {
  events: ReadonlyArray<{ kind: string; createdAt: Date }>;
  startedAt: Date | null;
  now: Date;
}): number {
  if (!opts.startedAt) return 0;
  const windowStart = opts.startedAt.getTime();
  const windowEnd = opts.now.getTime();
  const relevant = opts.events
    .filter((e) => e.kind === "awaiting_human" || e.kind === "resumed")
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  let totalMs = 0;
  let parkedSince: Date | null = null;
  for (const event of relevant) {
    if (event.kind === "awaiting_human") {
      if (parkedSince === null) parkedSince = event.createdAt;
    } else if (parkedSince !== null) {
      const from = Math.max(parkedSince.getTime(), windowStart);
      const to = Math.min(event.createdAt.getTime(), windowEnd);
      if (to > from) totalMs += to - from;
      parkedSince = null;
    }
  }
  return Math.max(0, Math.round(totalMs / 1_000));
}

const TRANSIENT_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ENOTFOUND",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EPIPE",
  "EHOSTUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

export function isTransientError(err: unknown, seen = new WeakSet<object>()): boolean {
  if (!err || typeof err !== "object") return false;
  if (seen.has(err)) return false;
  seen.add(err);
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_ERROR_CODES.has(code)) return true;
  const cause = (err as { cause?: unknown }).cause;
  if (cause && isTransientError(cause, seen)) return true;
  return false;
}

const MAX_ERROR_LOG_MESSAGE_LENGTH = 500;

export function agentRunErrorLogMeta(err: unknown): Record<string, string> | null {
  if (!err || typeof err !== "object") return null;
  const meta: Record<string, string> = {};
  if (err instanceof Error && err.name) meta.name = err.name;
  if (err instanceof Error && err.message) {
    meta.message = err.message.slice(0, MAX_ERROR_LOG_MESSAGE_LENGTH);
  }
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && /^[A-Z0-9_-]{1,64}$/i.test(code)) meta.code = code;
  return Object.keys(meta).length > 0 ? meta : null;
}

// Failure log message with the reason inlined as plain words. The reason must
// be in the message body (not only in structured attrs) because log issues
// fingerprint on the normalized body — a constant "agent run failed" string
// collapses every failure mode into one issue forever, so a brand-new failure
// mode never produces a new issue/incident/investigation. Spaces instead of
// underscores keep messageBucketFor from collapsing long enum tokens to <id>.
export function agentRunFailureLogMessage(reason: schema.AgentRunFailureReason): string {
  return `agent run failed: ${reason.replaceAll("_", " ")}`;
}

export async function failAgentRun(
  ctx: AgentRunContext,
  reason: schema.AgentRunFailureReason,
  summary: string,
  detail?: { existingResult?: AgentRunResult | null; err?: unknown },
  deps: ConditionalAgentRunStatusDeps = defaultConditionalAgentRunStatusDeps,
): Promise<boolean> {
  const category = schema.agentRunFailureCategory(reason);
  const failed = await deps.lifecycle.fail({
    id: ctx.agentRun.id,
    currentState: ctx.agentRun.state,
    reason,
    summary,
    category,
    existingResult: detail?.existingResult ?? null,
  });
  if (!failed) return false;
  await publishStatusIfCurrent(ctx, "failed", deps, async () => {
    if (detail?.existingResult) {
      await deps.applyIncidentMetadata(ctx, detail.existingResult);
    }
    deps.logError(
      {
        error: agentRunErrorLogMeta(detail?.err),
        scope: "agent_run",
        agent_run_id: ctx.agentRun.id,
        incident_id: ctx.incident.id,
        project_id: ctx.project.id,
        org_id: ctx.project.orgId,
        provider_session_id: ctx.agentRun.providerSessionId,
        from_state: ctx.agentRun.state,
        reason,
        category,
        runtime_minutes: ctx.agentRun.cumulativeRuntimeMinutes,
        resume_count: ctx.agentRun.resumeCount,
      },
      agentRunFailureLogMessage(reason),
    );
    await deps.enqueueAgentRunFailed(ctx.agentRun.id).catch((err) =>
      deps.logError(
        {
          scope: "webhooks.enqueue",
          agent_run_id: ctx.agentRun.id,
          err: err instanceof Error ? err.message : String(err),
        },
        "failed to enqueue incident.updated webhook (agent_failed)",
      ),
    );
    const emoji =
      category === "agent" ? ":mag:" : category === "deliverable" ? ":x:" : ":rotating_light:";
    await deps.postIncidentThreadMessage(ctx.incident.id, `${emoji} ${summary}`);
    await deps.postLinearIncidentError(ctx.incident.id, summary);
    const incidentUrl = buildContextIncidentUrl(WEB_ORIGIN, ctx);
    await deps.updateIncidentMainMessage(
      ctx.incident.id,
      `:x: ${ctx.incident.title} — Investigation failed`,
      incidentBlocks({
        emoji: "x",
        status: `Investigation failed · ${reason}`,
        title: ctx.incident.title,
        titleUrl: incidentUrl,
        tagline: summary,
        projectName: ctx.project.name,
        service: ctx.incident.service,
        buttons: [],
        incidentId: ctx.incident.id,
        showResolveButton: true,
        // No thumbs: the run errored out, so there are no investigation findings
        // to rate. A 👎 here would conflate "unhelpful findings" with "the run
        // crashed" and muddy the helpful/unhelpful signal.
      }),
    );
  });
  return true;
}

export async function moveAgentRunToAwaitingHuman(
  ctx: AgentRunContext,
  question: string,
  summary: string,
  result?: AgentRunResult,
  deps: ConditionalAgentRunStatusDeps = defaultConditionalAgentRunStatusDeps,
): Promise<boolean> {
  const paused = await deps.lifecycle.pauseForHuman({
    id: ctx.agentRun.id,
    currentState: ctx.agentRun.state,
    summary,
    question,
    result,
  });
  if (!paused) return false;
  await publishStatusIfCurrent(ctx, "awaiting_human", deps, async () => {
    if (result) await deps.applyIncidentMetadata(ctx, result);
    await deps
      .enqueueAgentRunAwaitingInput(ctx.agentRun.id, {
        reason: "repository_selection",
        summary,
        question,
      })
      .catch((err) =>
        deps.logError(
          {
            scope: "webhooks.enqueue",
            agent_run_id: ctx.agentRun.id,
            err: err instanceof Error ? err.message : String(err),
          },
          "failed to enqueue incident.updated webhook (agent_awaiting_input)",
        ),
      );
    await deps.postIncidentThreadMessage(
      ctx.incident.id,
      `:speech_balloon: ${summary}\n${question}`,
    );
    await deps.postLinearIncidentElicitation(ctx.incident.id, question);
    const incidentUrl = buildContextIncidentUrl(WEB_ORIGIN, ctx);
    await deps.updateIncidentMainMessage(
      ctx.incident.id,
      `:speech_balloon: ${ctx.incident.title} — Awaiting human input`,
      incidentBlocks({
        emoji: "speech_balloon",
        status: "Awaiting human input",
        title: ctx.incident.title,
        titleUrl: incidentUrl,
        tagline: question,
        projectName: ctx.project.name,
        service: ctx.incident.service,
        buttons: [],
        incidentId: ctx.incident.id,
        showResolveButton: true,
        showFeedbackButtons: true,
      }),
    );
  });
  return true;
}

export async function publishAwaitingEventsUpdateIfCurrent(opts: {
  isCurrent(): Promise<boolean>;
  publish(): Promise<void>;
  reconcileStalePublication(): Promise<void>;
}): Promise<"skipped" | "published" | "reconciled"> {
  if (!(await opts.isCurrent())) return "skipped";

  let publicationFailed = false;
  let publicationError: unknown;
  try {
    await opts.publish();
  } catch (err) {
    publicationFailed = true;
    publicationError = err;
  }

  if (!(await opts.isCurrent())) {
    await opts.reconcileStalePublication();
    if (publicationFailed) throw publicationError;
    return "reconciled";
  }
  if (publicationFailed) throw publicationError;
  return "published";
}

export type AwaitingEventsCompensationPresentation = {
  emoji: string;
  label: string;
  summary: string;
};

export function awaitingEventsCompensationPresentation(opts: {
  incidentStatus: schema.Incident["status"];
  agentRunState: schema.AgentRun["state"] | null;
  agentRunResult?: AgentRunResult | null;
}): AwaitingEventsCompensationPresentation | null {
  if (opts.incidentStatus !== "open") {
    const closed =
      opts.incidentStatus === "autoresolved_noise"
        ? { emoji: "no_bell", label: "Incident marked as noise" }
        : opts.incidentStatus === "merged"
          ? { emoji: "twisted_rightwards_arrows", label: "Incident merged" }
          : { emoji: "white_check_mark", label: "Incident resolved" };
    return {
      ...closed,
      summary: `${closed.label} while the previous waiting update was publishing.`,
    };
  }

  const current = (() => {
    switch (opts.agentRunState) {
      case "queued":
        return { emoji: "hourglass_flowing_sand", label: "Investigation queued" };
      case "repo_discovery":
        return { emoji: "mag", label: "Selecting a repository" };
      case "running":
        return { emoji: "arrow_forward", label: "Investigation resumed" };
      case "awaiting_human":
        return { emoji: "speech_balloon", label: "Awaiting human input" };
      case "resuming":
        return { emoji: "arrow_forward", label: "Investigation resuming" };
      case "pr_retry_queued":
        return { emoji: "arrows_counterclockwise", label: "PR delivery retry queued" };
      case "blocked_no_github":
        return { emoji: "no_entry", label: "Investigation blocked" };
      case "complete":
        return { emoji: "white_check_mark", label: "Investigation complete" };
      case "failed":
        return { emoji: "x", label: "Investigation failed" };
      case "awaiting_events":
        return opts.agentRunResult?.waitReason === "external_cause"
          ? { emoji: "warning", label: "Waiting on external cause" }
          : { emoji: "hourglass_flowing_sand", label: "Waiting on PR review" };
      case null:
        return null;
      default:
        return { emoji: "information_source", label: "Investigation updated" };
    }
  })();
  if (!current) return null;
  return {
    ...current,
    summary: `${current.label} while the previous waiting update was publishing.`,
  };
}

export async function reconcileStaleAgentRunPublication(ctx: AgentRunContext): Promise<void> {
  const [incident, agentRun] = await Promise.all([
    db.query.incidents.findFirst({
      where: (incidents, { eq }) => eq(incidents.id, ctx.incident.id),
    }),
    db.query.agentRuns.findFirst({
      where: (agentRuns, { eq }) => eq(agentRuns.incidentId, ctx.incident.id),
      columns: { state: true, result: true },
      orderBy: (agentRuns, { desc }) => [desc(agentRuns.createdAt), desc(agentRuns.id)],
    }),
  ]);
  if (!incident) return;

  const presentation = awaitingEventsCompensationPresentation({
    incidentStatus: incident.status,
    agentRunState: agentRun?.state ?? null,
    agentRunResult: agentRun?.result ?? null,
  });
  if (!presentation) return;

  const incidentUrl = buildContextIncidentUrl(WEB_ORIGIN, ctx);
  const tagline =
    incident.status === "open"
      ? (agentRun?.result?.summary ?? presentation.summary)
      : (incident.agentSummary ??
        incident.resolvedReasonText ??
        agentRun?.result?.summary ??
        presentation.summary);

  // Resolution or a resume may commit while the non-transactional provider
  // calls are in flight. Re-publish the aggregate's durable current state so
  // the waiting update cannot remain the final Slack/Linear state.
  await postIncidentThreadMessage(incident.id, `:${presentation.emoji}: ${presentation.summary}`);
  await updateIncidentMainMessage(
    incident.id,
    `:${presentation.emoji}: ${incident.title} — ${presentation.label}`,
    incidentBlocks({
      emoji: presentation.emoji,
      status: presentation.label,
      title: incident.title,
      titleUrl: incidentUrl,
      tagline,
      projectName: ctx.project.name,
      service: incident.service,
      buttons: [],
      incidentId: incident.id,
      showResolveButton: incident.status === "open",
      showFeedbackButtons: incident.status !== "open",
    }),
  );
  await postLinearIncidentResponse(incident.id, presentation.summary);
}

// Park a run after a terminal-for-turn outcome while it waits on PR lifecycle
// events or an external cause. The durable session resumes from inbound
// context. The discriminated outcome lets sync distinguish a competing pass
// from Incident resolution winning the shared row-lock protocol.
export async function moveAgentRunToAwaitingEvents(
  ctx: AgentRunContext,
  result: AgentRunResult,
  openPrUrls: string[],
  loadLinearTicket: () => Promise<{ identifier: string; url: string | null } | null> = async () =>
    null,
  applyMetadata = true,
): Promise<PauseForEventsOutcome> {
  const outcome = await agentRunLifecycle.pauseForEvents({
    id: ctx.agentRun.id,
    incidentId: ctx.incident.id,
    currentState: ctx.agentRun.state,
    result,
  });
  if (outcome.kind !== "parked") {
    logger.info(
      {
        scope: "agent_run",
        agent_run_id: ctx.agentRun.id,
        incident_id: ctx.incident.id,
        park_outcome: outcome.kind,
        incident_status: outcome.kind === "incident_not_open" ? outcome.incidentStatus : undefined,
      },
      outcome.kind === "incident_not_open"
        ? "skipping awaiting_events park; incident is no longer open"
        : "skipping awaiting_events park; a concurrent pass already transitioned the run",
    );
    return outcome;
  }
  // Cross-provider side effects happen only after this sync pass wins the
  // conditional state transition and a fresh aggregate snapshot still owns
  // the waiting state. A second snapshot compensates if resolution commits
  // while the provider calls are in flight.
  const publication = await publishAwaitingEventsUpdateIfCurrent({
    isCurrent: () =>
      agentRunLifecycle.canPublishAwaitingEventsUpdate({
        id: ctx.agentRun.id,
        incidentId: ctx.incident.id,
      }),
    publish: async () => {
      if (applyMetadata) await applyAndRefreshIncidentMetadata(ctx, result);
      const linearTicket = await loadLinearTicket();
      const externalCause = result.waitReason === "external_cause" ? result.externalCause : null;
      await postIncidentThreadMessage(
        ctx.incident.id,
        awaitingEventsSlackMessage(openPrUrls, linearTicket, externalCause),
      );
      const incidentUrl = buildContextIncidentUrl(WEB_ORIGIN, ctx);
      const isExternalCause = !!externalCause;
      await updateIncidentMainMessage(
        ctx.incident.id,
        isExternalCause
          ? `:warning: ${ctx.incident.title} — Waiting on external cause`
          : `:hourglass_flowing_sand: ${ctx.incident.title} — Waiting on PR review`,
        incidentBlocks({
          emoji: isExternalCause ? "warning" : "hourglass_flowing_sand",
          status: isExternalCause ? "Waiting on external cause" : "Waiting on PR review",
          title: ctx.incident.title,
          tagline: isExternalCause
            ? `${externalCause.source}: ${externalCause.cause}`
            : result.summary || "The investigation opened PRs and is waiting for review or merge.",
          projectName: ctx.project.name,
          service: ctx.incident.service,
          buttons: [
            { text: "Open in Superlog", url: incidentUrl, actionId: "open_superlog" },
            ...(openPrUrls[0]
              ? [{ text: "View PR", url: openPrUrls[0], actionId: "view_pr" }]
              : []),
            ...(linearTicket?.url
              ? [
                  {
                    text: `View ${linearTicket.identifier}`,
                    url: linearTicket.url,
                    actionId: "view_linear",
                  },
                ]
              : []),
          ],
          incidentId: ctx.incident.id,
          showResolveButton: true,
          // The one-click merge action targets "the incident's latest open PR",
          // so with several PRs out it would merge only one and resolve the whole
          // incident — only offer it when the target is unambiguous.
          showMergePrButton: openPrUrls.length === 1,
        }),
      );
    },
    reconcileStalePublication: () => reconcileStaleAgentRunPublication(ctx),
  });
  if (publication !== "published") {
    logger.info(
      {
        scope: "agent_run.awaiting_events",
        agent_run_id: ctx.agentRun.id,
        incident_id: ctx.incident.id,
        publication,
      },
      publication === "skipped"
        ? "skipped stale awaiting-events provider update"
        : "reconciled awaiting-events provider update after aggregate state changed",
    );
  }
  return outcome;
}

export function awaitingEventsSlackMessage(
  openPrUrls: string[],
  linearTicket: { identifier: string; url: string | null } | null,
  externalCause?: AgentRunExternalCause | null,
): string {
  if (externalCause) {
    return `:warning: Investigation found an external cause in ${externalCause.source} and remains open. ${externalCause.cause} Next step: ${externalCause.recommendedNextStep}`;
  }
  const prList = openPrUrls.length > 0 ? ` Open PRs: ${openPrUrls.join(", ")}` : "";
  const ticket = linearTicket
    ? ` Linear ticket: ${linearTicket.identifier}${linearTicket.url ? ` (${linearTicket.url})` : ""}`
    : "";
  return `:hourglass_flowing_sand: Investigation is waiting on PR review.${prList}${ticket}`;
}

export async function moveAgentRunToBlockedNoGithub(
  ctx: AgentRunContext,
  reason: "no_github_install" | "no_accessible_repos",
  summary: string,
  deps: ConditionalAgentRunStatusDeps = defaultConditionalAgentRunStatusDeps,
): Promise<boolean> {
  const blocked = await deps.lifecycle.blockForGithub({
    id: ctx.agentRun.id,
    currentState: ctx.agentRun.state,
    summary,
    reason,
  });
  if (!blocked) return false;
  await publishStatusIfCurrent(ctx, "blocked_no_github", deps, async () => {
    await deps
      .enqueueAgentRunAwaitingInput(ctx.agentRun.id, {
        reason,
        summary,
        question: null,
      })
      .catch((err) =>
        deps.logError(
          {
            scope: "webhooks.enqueue",
            agent_run_id: ctx.agentRun.id,
            err: err instanceof Error ? err.message : String(err),
          },
          "failed to enqueue incident.updated webhook (agent_awaiting_input)",
        ),
      );
    const incidentUrl = buildContextIncidentUrl(WEB_ORIGIN, ctx);
    const installUrl = `${WEB_ORIGIN}/settings?tab=github`;
    const tagline = "Connect a GitHub repo so we can investigate.";
    await deps.postIncidentThreadMessage(
      ctx.incident.id,
      `:no_entry: ${summary}\nConnect GitHub: ${installUrl}`,
    );
    await deps.updateIncidentMainMessage(
      ctx.incident.id,
      `:no_entry: ${ctx.incident.title} — Investigation blocked`,
      incidentBlocks({
        emoji: "no_entry",
        status: "Investigation blocked — connect GitHub",
        title: ctx.incident.title,
        titleUrl: incidentUrl,
        tagline,
        projectName: ctx.project.name,
        service: ctx.incident.service,
        buttons: [{ text: "Connect GitHub", url: installUrl, actionId: "connect_github" }],
        incidentId: ctx.incident.id,
        showResolveButton: true,
        // No thumbs: the investigation is blocked before it can start (no GitHub
        // repo connected), so there's nothing to rate yet.
      }),
    );
  });
  return true;
}
