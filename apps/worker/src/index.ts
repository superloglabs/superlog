import "./env.js";
import { createClient } from "@clickhouse/client";
import { db } from "@superlog/db";
import { registerAgentRunHealthMetrics } from "./agent-run-health-metrics.js";
import { initAiUsageSink } from "./ai-usage.js";
import { createUsageMeterTicker } from "./billing/usage-meter-ticker.js";
import { handleIssueTransition } from "./incidents/workflow.js";
import { startJobRunner } from "./jobs/runner.js";
import { logger } from "./logger.js";
import { registerDatastoreObservability } from "./observability/datastores.js";
import { createTelemetryIngestor, registerTelemetryIngestMetrics } from "./telemetry/ingest.js";
import { registerTenantMetrics } from "./tenant-metrics.js";
import { runWorker } from "./worker/runtime.js";
import { createWorkerTick } from "./worker/tick.js";

logger.info({ scope: "boot" }, "env loaded");

// Install the configured AI-usage sink before any tick can record usage.
// No-op unless AI_USAGE_SINK_MODULE is set (stock / self-hosted builds).
await initAiUsageSink();

registerTenantMetrics();
registerAgentRunHealthMetrics();

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

const telemetryIngestor = createTelemetryIngestor({
  clickhouse: ch,
  batchSize: BATCH_SIZE,
  discoveryWindowMs: TELEMETRY_DISCOVERY_WINDOW_MS,
  handleIssueTransition,
});
registerTelemetryIngestMetrics({
  clickhouse: ch,
  discoveryWindowMs: TELEMETRY_DISCOVERY_WINDOW_MS,
});

const usageMeter = createUsageMeterTicker({ db, clickhouse: ch });
const tick = createWorkerTick({ clickhouse: ch, telemetryIngestor, usageMeter });

// Start the pg-boss background job runner: discovers jobs from the jobs dir and
// schedules them on their own queues, OUTSIDE this tick loop. A runner failure
// must not take down telemetry ingest, so it is isolated — log and continue.
try {
  await startJobRunner({ db, clickhouse: ch });
} catch (err) {
  logger.error(
    { scope: "boot", err: err instanceof Error ? err.message : String(err) },
    "background job runner failed to start; continuing without it",
  );
}

runWorker({ pollIntervalMs: POLL_INTERVAL_MS, batchSize: BATCH_SIZE, tick }).catch((err) => {
  logger.fatal({ err }, "worker crashed");
  process.exit(1);
});
