import type { schema } from "@superlog/db";
import { fetchTraceContext } from "../infra/clickhouse/trace-context.js";

function buildIssueSummary(issue: schema.Issue) {
  return {
    id: issue.id,
    title: issue.title,
    exceptionType: issue.exceptionType,
    message: issue.message,
    topFrame: issue.topFrame,
    normalizedFrames: issue.normalizedFrames ?? [],
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
