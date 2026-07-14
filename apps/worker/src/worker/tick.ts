import { SpanStatusCode, trace } from "@opentelemetry/api";
import { tickAgentChats } from "../agent-chats/tick.js";
import { tickAgentRuns } from "../agent-runs/tick.js";
import { tickAlerts } from "../alerts.js";
import { tickAutorecovery } from "../autorecovery.js";
import { tickDigests } from "../digest.js";
import { handleIssueTransition } from "../incidents/workflow.js";
import { logger } from "../logger.js";
import { tickObservedIssues } from "../observation.js";
import type { TelemetryIngestor } from "../telemetry/ingest.js";
import { tickWebhooks } from "../webhooks.js";

const tracer = trace.getTracer("@superlog/worker");

type ClickHouseClientLike = Parameters<typeof tickAlerts>[0];

export type WorkerTickResult = {
  spans: number;
  logs: number;
  agentRuns: number;
  agentChats: number;
  alerts: number;
  digests: number;
  webhooks: number;
  autorecoveryProposals: number;
  observedEscalations: number;
  usageReported: number;
};

export function createWorkerTick(opts: {
  clickhouse: ClickHouseClientLike;
  telemetryIngestor: TelemetryIngestor;
  usageMeter?: (() => Promise<number>) | null;
  // Injected so callers can route transition side effects out-of-band (see
  // issue-transitions.ts); defaults to the direct inline workflow.
  handleIssueTransition?: typeof handleIssueTransition;
  // Agent runs normally advance on their own pg-boss queue (agent-runs/
  // queue.ts). The tick's batch rotation is kept only as the fallback for a
  // boot where that queue failed to register — pass false once the queue is
  // live so runs aren't advanced from two places at once.
  includeAgentRuns?: boolean;
  // Autorecovery normally runs as an hourly pg-boss cron job
  // (startAutorecoveryJob in autorecovery.ts) so its 50-candidate LLM loop
  // doesn't block the tick heartbeat. Pass false once that job is live; the
  // tick path remains the fallback for deployments where pg-boss is
  // unavailable or ANTHROPIC_API_KEY is unset.
  includeAutorecovery?: boolean;
}): () => Promise<WorkerTickResult> {
  const onIssueTransition = opts.handleIssueTransition ?? handleIssueTransition;
  const includeAgentRuns = opts.includeAgentRuns ?? true;
  const includeAutorecovery = opts.includeAutorecovery ?? true;
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
        const agentRuns = includeAgentRuns ? await safe("agent_runs", tickAgentRuns, 0) : 0;
        const agentChats = await safe("agent_chats", tickAgentChats, 0);
        const alerts = await safe(
          "alerts",
          () => tickAlerts(opts.clickhouse, onIssueTransition),
          0,
        );
        const digests = await safe("digests", tickDigests, 0);
        const webhooks = await safe("webhooks", tickWebhooks, 0);
        const autorecoveryProposals = includeAutorecovery
          ? await safe("autorecovery", tickAutorecovery, 0)
          : 0;
        const observedEscalations = await safe(
          "observation",
          () => tickObservedIssues(onIssueTransition),
          0,
        );
        const usageReported = opts.usageMeter
          ? await safe("usage_metering", opts.usageMeter, 0)
          : 0;
        span.setAttribute("tick.spans", spans);
        span.setAttribute("tick.logs", logs);
        span.setAttribute("tick.agent_runs", agentRuns);
        span.setAttribute("tick.agent_chats", agentChats);
        span.setAttribute("tick.alerts", alerts);
        span.setAttribute("tick.digests", digests);
        span.setAttribute("tick.webhooks", webhooks);
        span.setAttribute("tick.autorecovery_proposals", autorecoveryProposals);
        span.setAttribute("tick.observed_escalations", observedEscalations);
        span.setAttribute("tick.usage_reported", usageReported);
        return {
          spans,
          logs,
          agentRuns,
          agentChats,
          alerts,
          digests,
          webhooks,
          autorecoveryProposals,
          observedEscalations,
          usageReported,
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
