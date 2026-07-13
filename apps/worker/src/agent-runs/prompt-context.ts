import { db, type schema } from "@superlog/db";
import { eq } from "drizzle-orm";
import type { AgentRunnerAlertEpisode } from "../agent-runner-backend.js";
import { fetchTraceContext } from "../infra/clickhouse/trace-context.js";
import { findAlertEpisodeForIssue } from "../issues/repository.js";

const STACKTRACE_PREVIEW_CHARS = 4_000;

function buildIssueSummary(issue: schema.Issue) {
  const sample = (issue.lastSample ?? null) as schema.IssueSample | null;
  return {
    id: issue.id,
    title: issue.title,
    exceptionType: issue.exceptionType,
    message: issue.message,
    topFrame: issue.topFrame,
    normalizedFrames: issue.normalizedFrames ?? [],
    stacktrace: stacktracePreview(sample?.stacktrace ?? null),
    sessionId: sessionIdForSample(sample),
    lastSample: issue.lastSample ?? null,
    traceContext: null as string | null,
    alertEpisode: null as AgentRunnerAlertEpisode | null,
  };
}

export async function buildIssueSummaryWithTrace(
  projectId: string,
  issue: schema.Issue,
): Promise<ReturnType<typeof buildIssueSummary>> {
  const base = buildIssueSummary(issue);
  if (issue.kind === "alert") {
    // An alert-episode issue's trigger context is the alert config + the
    // breach window, not a stack trace: the issue's sample is a synthetic
    // echo of the title and only misleads the agent into hunting for frames.
    return {
      ...base,
      lastSample: null,
      alertEpisode: await loadAlertEpisodeContext(issue.id),
    };
  }
  const sample = (issue.lastSample ?? null) as schema.IssueSample | null;
  const traceId = sample?.traceId ?? null;
  const spanId = sample?.spanId ?? null;
  if (!traceId) return base;
  // The sample's own timestamp bounds the span lookup (see fetchTraceContext);
  // fall back to the issue's lastSeen, which the sample tracks by construction.
  const sampleSeenAt = sample?.seenAt ? new Date(sample.seenAt) : null;
  const hintTs =
    sampleSeenAt && Number.isFinite(sampleSeenAt.getTime())
      ? sampleSeenAt
      : (issue.lastSeen ?? null);
  const traceContext = await fetchTraceContext(projectId, traceId, spanId ?? null, hintTs);
  return { ...base, traceContext };
}

async function loadAlertEpisodeContext(issueId: string): Promise<AgentRunnerAlertEpisode | null> {
  const episode = await findAlertEpisodeForIssue(issueId);
  if (!episode) return null;
  const alert = await db.query.alerts.findFirst({
    where: (alerts) => eq(alerts.id, episode.alertId),
  });
  if (!alert) return null;
  return {
    alert: {
      id: alert.id,
      name: alert.name,
      source: alert.source,
      metricName: alert.metricName,
      filter: (alert.filter ?? {}) as Record<string, unknown>,
      groupBy: alert.groupBy,
      groupMode: alert.groupMode,
      aggregation: alert.aggregation,
      comparator: alert.comparator,
      threshold: alert.threshold,
      windowMinutes: alert.windowMinutes,
      evaluationIntervalSeconds: alert.evaluationIntervalSeconds,
    },
    episode: {
      id: episode.id,
      groupKey: episode.groupKey,
      state: episode.state,
      startedAt: episode.startedAt.toISOString(),
      endedAt: episode.endedAt?.toISOString() ?? null,
      openObservedValue: episode.openObservedValue,
      peakObservedValue: episode.peakObservedValue,
      lastObservedValue: episode.lastObservedValue,
      lastFiringAt: episode.lastFiringAt.toISOString(),
    },
  };
}

function stacktracePreview(stacktrace: string | null): string | null {
  if (!stacktrace) return null;
  if (stacktrace.length <= STACKTRACE_PREVIEW_CHARS) return stacktrace;
  return `${stacktrace.slice(0, STACKTRACE_PREVIEW_CHARS)}\n...[stacktrace truncated]`;
}

function sessionIdForSample(sample: schema.IssueSample | null): string | null {
  return (
    sample?.logAttrs?.["session.id"] ??
    sample?.spanAttrs?.["session.id"] ??
    sample?.resourceAttrs?.["session.id"] ??
    null
  );
}
