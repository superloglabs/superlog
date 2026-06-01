import "./env.js";
import { createClient } from "@clickhouse/client";
import { db } from "@superlog/db";
import { createAttioSyncTicker } from "./attio/tick.js";
import { createUsageMeterTicker } from "./billing/usage-meter-ticker.js";
import { handleIssueTransition } from "./incidents/workflow.js";
import { logger } from "./logger.js";
import { registerDatastoreObservability } from "./observability/datastores.js";
import { createTelemetryIngestor, registerTelemetryIngestMetrics } from "./telemetry/ingest.js";
import { registerTenantMetrics } from "./tenant-metrics.js";
import { runWorker } from "./worker/runtime.js";
import { createWorkerTick } from "./worker/tick.js";

logger.info({ scope: "boot" }, "env loaded");

registerTenantMetrics();

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

const attioSync = createAttioSyncTicker({ db, clickhouse: ch });
const usageMeter = createUsageMeterTicker({ db, clickhouse: ch });
const tick = createWorkerTick({ clickhouse: ch, telemetryIngestor, attioSync, usageMeter });

runWorker({ pollIntervalMs: POLL_INTERVAL_MS, batchSize: BATCH_SIZE, tick }).catch((err) => {
  logger.fatal({ err }, "worker crashed");
  process.exit(1);
});
