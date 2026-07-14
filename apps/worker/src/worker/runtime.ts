import { logger } from "../logger.js";
import { recordTickHeartbeat } from "../queue-health.js";
import type { WorkerTickResult } from "./tick.js";

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

export async function runWorker(opts: {
  pollIntervalMs: number;
  batchSize: number;
  signal?: AbortSignal;
  tick(): Promise<WorkerTickResult>;
}): Promise<void> {
  logger.info({ pollMs: opts.pollIntervalMs, batchSize: opts.batchSize }, "worker up");
  while (!opts.signal?.aborted) {
    try {
      const { spans, logs, agentRuns, alerts, digests, webhooks } = await opts.tick();
      // Heartbeat for the tick-lateness gauge/alarm: recorded only on a
      // completed cycle, so a wedged step shows up as a climbing age even
      // while the process stays alive.
      recordTickHeartbeat();
      if (spans > 0 || logs > 0 || agentRuns > 0 || alerts > 0 || digests > 0 || webhooks > 0) {
        logger.info(
          {
            spans,
            logs,
            agentRuns,
            alerts,
            digests,
            webhooks,
          },
          "processed",
        );
      }
    } catch (err) {
      logger.error({ err }, "tick failed");
    }
    await sleep(opts.pollIntervalMs, opts.signal);
  }
}
