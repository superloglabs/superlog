import "./env.js";
import { createClient } from "@clickhouse/client";
import { db } from "@superlog/db";
import { registerAgentRunHealthMetrics } from "./agent-run-health-metrics.js";
import { initAiUsageSink } from "./ai-usage.js";
import { createUsageMeterTicker } from "./billing/usage-meter-ticker.js";
import { handleIssueTransition } from "./incidents/workflow.js";
import {
  createIssueTransitionDispatcher,
  registerIssueTransitionWorker,
} from "./issue-transitions.js";
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

// Telemetry usage metering runs in the tick; the usage-limit notifier runs
// out-of-band as the `usage-notify` pg-boss job (jobs/usage-notify.ts), which
// derives active orgs from ClickHouse itself — no coupling to the tick.
const usageMeter = createUsageMeterTicker({ db, clickhouse: ch });
const tick = createWorkerTick({
  clickhouse: ch,
  telemetryIngestor,
  usageMeter,
  handleIssueTransition: dispatchIssueTransition,
});

runWorker({ pollIntervalMs: POLL_INTERVAL_MS, batchSize: BATCH_SIZE, tick }).catch((err) => {
  logger.fatal({ err }, "worker crashed");
  process.exit(1);
});
