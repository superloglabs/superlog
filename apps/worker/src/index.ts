import "./env.js";
import { createClient } from "@clickhouse/client";
import { db, shutdownAnalytics } from "@superlog/db";
import { registerAgentRunHealthMetrics } from "./agent-run-health-metrics.js";
import { startAgentRunQueue } from "./agent-runs/queue-wiring.js";
import { initAiUsageSink } from "./ai-usage.js";
import { handleIssueTransition } from "./incidents/workflow.js";
import {
  createIssueTransitionDispatcher,
  registerIssueTransitionWorker,
} from "./issue-transitions.js";
import { startJobRunner } from "./jobs/runner.js";
import { logger } from "./logger.js";
import { registerDatastoreObservability } from "./observability/datastores.js";
import { registerQueueHealthMetrics } from "./queue-health.js";
import { shutdownTelemetry } from "./telemetry-shutdown.js";
import { createTelemetryIngestor, registerTelemetryIngestMetrics } from "./telemetry/ingest.js";
import { registerTenantMetrics } from "./tenant-metrics.js";
import { runWorker } from "./worker/runtime.js";
import { drainWorker, shutdownWorkerProcess } from "./worker/shutdown.js";
import { createWorkerTick } from "./worker/tick.js";

logger.info({ scope: "boot" }, "env loaded");

// Install the configured AI-usage sink before any tick can record usage.
// No-op unless AI_USAGE_SINK_MODULE is set (stock / self-hosted builds).
await initAiUsageSink();

registerTenantMetrics();
registerAgentRunHealthMetrics();
registerQueueHealthMetrics();

const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL ?? "http://localhost:8123";
const CLICKHOUSE_DB = process.env.CLICKHOUSE_DB ?? "superlog";
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 3000);
const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? 500);
const TELEMETRY_DISCOVERY_WINDOW_MS = Number(process.env.TELEMETRY_DISCOVERY_WINDOW_MS);

const ch = createClient({
  url: CLICKHOUSE_URL,
  username: process.env.CLICKHOUSE_USER ?? "default",
  password: process.env.CLICKHOUSE_PASSWORD ?? "",
  database: CLICKHOUSE_DB,
});

registerDatastoreObservability({ db, clickhouse: ch, logger });

// Start the pg-boss background job runner first: it hosts the cron jobs from
// the jobs dir AND the issue-transition queue the ingest tick enqueues onto.
// A runner failure must not take down telemetry ingest, so it is isolated —
// log and continue; the dispatcher falls back to inline transitions.
let jobBoss: Awaited<ReturnType<typeof startJobRunner>> = null;
try {
  jobBoss = await startJobRunner({ db, clickhouse: ch });
} catch (err) {
  logger.error(
    { scope: "boot", err: err instanceof Error ? err.message : String(err) },
    "background job runner failed to start; continuing without it",
  );
}

// Issue-transition side effects (incident intake with its LLM grouping call,
// notifications, agent-run routing) run out-of-band on a pg-boss queue so a
// burst of new fingerprints can't stall the ingest cursor for other projects.
// If the queue worker fails to register, drop the boss reference so the
// dispatcher runs transitions inline — a registration failure must degrade,
// not crash boot or enqueue jobs nothing will ever work.
let transitionBoss = jobBoss;
if (transitionBoss) {
  try {
    await registerIssueTransitionWorker(transitionBoss, {
      handle: handleIssueTransition,
      loadIssue: async (issueId) =>
        db.query.issues.findFirst({ where: (issues, { eq }) => eq(issues.id, issueId) }),
    });
  } catch (err) {
    logger.error(
      { scope: "boot", err: err instanceof Error ? err.message : String(err) },
      "issue-transition worker failed to register; falling back to inline transitions",
    );
    transitionBoss = null;
  }
}
const dispatchIssueTransition = createIssueTransitionDispatcher({
  boss: transitionBoss,
  inline: handleIssueTransition,
});

// Agent runs advance as per-run jobs on their own pg-boss queue (one job per
// run, minute sweep as the safety net) so investigation throughput no longer
// depends on the size of the global active set. If registration fails, the
// tick's batch rotation below remains the fallback — degraded cadence, but
// investigations still advance.
let agentRunQueueReady = false;
if (jobBoss) {
  try {
    await startAgentRunQueue(jobBoss);
    agentRunQueueReady = true;
  } catch (err) {
    logger.error(
      { scope: "boot", err: err instanceof Error ? err.message : String(err) },
      "agent-run queue failed to register; falling back to tick batch rotation",
    );
  }
}

const telemetryIngestor = createTelemetryIngestor({
  clickhouse: ch,
  batchSize: BATCH_SIZE,
  discoveryWindowMs: TELEMETRY_DISCOVERY_WINDOW_MS,
  handleIssueTransition: dispatchIssueTransition,
});
registerTelemetryIngestMetrics({
  clickhouse: ch,
  discoveryWindowMs: TELEMETRY_DISCOVERY_WINDOW_MS,
});

const tick = createWorkerTick({
  clickhouse: ch,
  telemetryIngestor,
  handleIssueTransition: dispatchIssueTransition,
  includeAgentRuns: !agentRunQueueReady,
});

const workerController = new AbortController();
const workerLoop = runWorker({
  pollIntervalMs: POLL_INTERVAL_MS,
  batchSize: BATCH_SIZE,
  signal: workerController.signal,
  tick,
}).catch((err) => {
  logger.fatal({ err }, "worker crashed");
  process.exit(1);
});

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "received shutdown signal; draining");

  const exitCode = await shutdownWorkerProcess({
    drain: () =>
      drainWorker({
        stopTickLoop: () => workerController.abort(),
        tickLoop: workerLoop,
        jobRunner: jobBoss,
        closeClickHouse: () => ch.close(),
      }),
    shutdownAnalytics,
    shutdownTelemetry,
    onError: (phase, err) => {
      logger.error({ err, phase }, "worker shutdown phase failed");
    },
  });
  process.exit(exitCode);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
