import { SpanStatusCode, trace } from "@opentelemetry/api";
import { tickAgentChats } from "../agent-chats/tick.js";
import { tickAgentRuns } from "../agent-runs/tick.js";
import { tickAlerts } from "../alerts.js";
import { tickDigests } from "../digest.js";
import { handleIssueTransition } from "../incidents/workflow.js";
import { logger } from "../logger.js";
import { tickObservedIssues } from "../observation.js";
import { tickSentryIssueEvents } from "../sentry/tick.js";
import type { TelemetryIngestor } from "../telemetry/ingest.js";
import { tickWebhooks } from "../webhooks.js";

const tracer = trace.getTracer("@superlog/worker");

type ClickHouseClientLike = Parameters<typeof tickAlerts>[0];

export type WorkerTickResult = {
  spans: number;
  logs: number;
  agentRuns: number;
  agentChats: number;
  sentryEvents: number;
  alerts: number;
  digests: number;
  webhooks: number;
  observedEscalations: number;
};

// Steps that normally run out-of-band on pg-boss (agent runs on their own
// advance queue, the rest as recurring chains — see worker/recurring-steps.ts)
// and run in the tick only when pg-boss is unavailable to this process. The
// telemetry scan (spans/logs) is not skippable: it IS the tick until its own
// migration.
export type SkippableTickStep =
  | "agent_runs"
  | "agent_chats"
  | "sentry_events"
  | "alerts"
  | "digests"
  | "webhooks"
  | "observation";

export function createWorkerTick(opts: {
  clickhouse: ClickHouseClientLike;
  telemetryIngestor: TelemetryIngestor;
  // Injected so callers can route transition side effects out-of-band (see
  // issue-transitions.ts); defaults to the direct inline workflow.
  handleIssueTransition?: typeof handleIssueTransition;
  // Steps whose pg-boss registration succeeded — skipped here so a step never
  // runs from two places at once.
  skipSteps?: ReadonlySet<SkippableTickStep>;
}): () => Promise<WorkerTickResult> {
  const onIssueTransition = opts.handleIssueTransition ?? handleIssueTransition;
  const skip = opts.skipSteps ?? new Set<SkippableTickStep>();
  return () =>
    tracer.startActiveSpan("worker.tick", async (span) => {
      async function safe<T>(name: string, run: () => Promise<T>, fallback: T): Promise<T> {
        try {
          return await run();
        } catch (err) {
          const cause = err instanceof Error ? (err as { cause?: unknown }).cause : undefined;
          const causeRecord =
            cause && typeof cause === "object" ? (cause as Record<string, unknown>) : undefined;
          logger.error(
            {
              scope: "worker.tick",
              step: name,
              err: err instanceof Error ? err.message : String(err),
              causeMessage:
                cause instanceof Error ? cause.message : causeRecord ? undefined : cause,
              causeCode: causeRecord?.code,
              causeSeverity: causeRecord?.severity,
              causeDetail: causeRecord?.detail,
              causeRoutine: causeRecord?.routine,
              stack: err instanceof Error ? err.stack : undefined,
            },
            "tick step failed",
          );
          return fallback;
        }
      }
      try {
        const spans = await safe("spans", opts.telemetryIngestor.tickSpans, 0);
        const logs = await safe("logs", opts.telemetryIngestor.tickLogs, 0);
        const agentRuns = skip.has("agent_runs") ? 0 : await safe("agent_runs", tickAgentRuns, 0);
        const agentChats = skip.has("agent_chats")
          ? 0
          : await safe("agent_chats", tickAgentChats, 0);
        const sentryEvents = skip.has("sentry_events")
          ? 0
          : await safe("sentry_events", () => tickSentryIssueEvents(onIssueTransition), 0);
        const alerts = skip.has("alerts")
          ? 0
          : await safe("alerts", () => tickAlerts(opts.clickhouse, onIssueTransition), 0);
        const digests = skip.has("digests") ? 0 : await safe("digests", tickDigests, 0);
        const webhooks = skip.has("webhooks") ? 0 : await safe("webhooks", tickWebhooks, 0);
        const observedEscalations = skip.has("observation")
          ? 0
          : await safe("observation", () => tickObservedIssues(onIssueTransition), 0);
        span.setAttribute("tick.spans", spans);
        span.setAttribute("tick.logs", logs);
        span.setAttribute("tick.agent_runs", agentRuns);
        span.setAttribute("tick.agent_chats", agentChats);
        span.setAttribute("tick.sentry_events", sentryEvents);
        span.setAttribute("tick.alerts", alerts);
        span.setAttribute("tick.digests", digests);
        span.setAttribute("tick.webhooks", webhooks);
        span.setAttribute("tick.observed_escalations", observedEscalations);
        return {
          spans,
          logs,
          agentRuns,
          agentChats,
          sentryEvents,
          alerts,
          digests,
          webhooks,
          observedEscalations,
        };
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        span.end();
      }
    });
}
