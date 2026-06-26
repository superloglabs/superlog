import { SpanStatusCode, trace } from "@opentelemetry/api";
import { tickAgentRuns } from "../agent-runs/tick.js";
import { tickAlerts } from "../alerts.js";
import { tickAutorecovery } from "../autorecovery.js";
import { tickDigests } from "../digest.js";
import { handleIssueTransition } from "../incidents/workflow.js";
import { logger } from "../logger.js";
import type { TelemetryIngestor } from "../telemetry/ingest.js";
import { tickWebhooks } from "../webhooks.js";

const tracer = trace.getTracer("@superlog/worker");

type ClickHouseClientLike = Parameters<typeof tickAlerts>[0];

export type WorkerTickResult = {
  spans: number;
  logs: number;
  agentRuns: number;
  alerts: number;
  digests: number;
  webhooks: number;
  autorecoveryProposals: number;
  usageReported: number;
  usageNotified: number;
};

export function createWorkerTick(opts: {
  clickhouse: ClickHouseClientLike;
  telemetryIngestor: TelemetryIngestor;
  usageMeter?: (() => Promise<number>) | null;
  usageNotifierTick?: (() => Promise<number>) | null;
}): () => Promise<WorkerTickResult> {
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
        const agentRuns = await safe("agent_runs", tickAgentRuns, 0);
        const alerts = await safe(
          "alerts",
          () => tickAlerts(opts.clickhouse, handleIssueTransition),
          0,
        );
        const digests = await safe("digests", tickDigests, 0);
        const webhooks = await safe("webhooks", tickWebhooks, 0);
        const autorecoveryProposals = await safe("autorecovery", tickAutorecovery, 0);
        const usageReported = opts.usageMeter
          ? await safe("usage_metering", opts.usageMeter, 0)
          : 0;
        const usageNotified = opts.usageNotifierTick
          ? await safe("usage_notify", opts.usageNotifierTick, 0)
          : 0;
        span.setAttribute("tick.spans", spans);
        span.setAttribute("tick.logs", logs);
        span.setAttribute("tick.agent_runs", agentRuns);
        span.setAttribute("tick.alerts", alerts);
        span.setAttribute("tick.digests", digests);
        span.setAttribute("tick.webhooks", webhooks);
        span.setAttribute("tick.autorecovery_proposals", autorecoveryProposals);
        span.setAttribute("tick.usage_reported", usageReported);
        span.setAttribute("tick.usage_notified", usageNotified);
        return {
          spans,
          logs,
          agentRuns,
          alerts,
          digests,
          webhooks,
          autorecoveryProposals,
          usageReported,
          usageNotified,
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
