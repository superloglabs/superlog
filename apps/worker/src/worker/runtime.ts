import { logger } from "../logger.js";
import { recordTickHeartbeat } from "../queue-health.js";
import type { WorkerTickResult } from "./tick.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runWorker(opts: {
  pollIntervalMs: number;
  batchSize: number;
  tick(): Promise<WorkerTickResult>;
}): Promise<void> {
  logger.info({ pollMs: opts.pollIntervalMs, batchSize: opts.batchSize }, "worker up");
  while (true) {
    try {
      const { spans, logs, agentRuns, alerts, digests, webhooks, autorecoveryProposals } =
        await opts.tick();
      // Heartbeat for the tick-lateness gauge/alarm: recorded only on a
      // completed cycle, so a wedged step shows up as a climbing age even
      // while the process stays alive.
      recordTickHeartbeat();
      if (
        spans > 0 ||
        logs > 0 ||
        agentRuns > 0 ||
        alerts > 0 ||
        digests > 0 ||
        webhooks > 0 ||
        autorecoveryProposals > 0
      ) {
        logger.info(
          {
            spans,
            logs,
            agentRuns,
            alerts,
            digests,
            webhooks,
            autorecoveryProposals,
          },
          "processed",
        );
      }
    } catch (err) {
      logger.error({ err }, "tick failed");
    }
    await sleep(opts.pollIntervalMs);
  }
}
