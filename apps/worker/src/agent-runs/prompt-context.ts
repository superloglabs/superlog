import type { schema } from "@superlog/db";
import { fetchTraceContext } from "../infra/clickhouse/trace-context.js";

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
  };
}

export async function buildIssueSummaryWithTrace(
  projectId: string,
  issue: schema.Issue,
): Promise<ReturnType<typeof buildIssueSummary>> {
  const base = buildIssueSummary(issue);
  const sample = (issue.lastSample ?? null) as schema.IssueSample | null;
  const traceId = sample?.traceId ?? null;
  const spanId = sample?.spanId ?? null;
  if (!traceId) return base;
  const traceContext = await fetchTraceContext(projectId, traceId, spanId ?? null);
  return { ...base, traceContext };
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
