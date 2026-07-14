// Autorecovery can spend minutes waiting on one LLM call per incident. Keep it
// on an exclusive pg-boss queue so it never delays telemetry ingest, alert
// evaluation, or the worker-loop heartbeat. The five-minute schedule is only a
// wake-up cadence: tickAutorecovery's durable cursor retains the hourly policy.
import { tickAutorecovery } from "../autorecovery.js";
import type { JobDefinition } from "../jobs.js";

export function createAutorecoveryJob(
  options: {
    apiKey?: string | null;
    run?: () => Promise<number>;
  } = {},
): JobDefinition {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  const run = options.run ?? tickAutorecovery;
  return {
    name: "autorecovery",
    schedule: "*/5 * * * *",
    expireInSeconds: 3_600,
    create: () => {
      if (!apiKey?.trim()) return null;
      return async () => {
        await run();
      };
    },
  };
}

export const job = createAutorecoveryJob();
