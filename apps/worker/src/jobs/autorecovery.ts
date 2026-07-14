// Autorecovery can spend minutes waiting on one LLM call per incident. Keep it
// on an exclusive pg-boss queue so it never delays telemetry ingest, alert
// evaluation, or the worker-loop heartbeat. The five-minute schedule is only a
// wake-up cadence: tickAutorecovery's durable cursor retains the hourly policy.
import { tickAutorecovery } from "../autorecovery.js";
import type { JobDefinition } from "../jobs.js";

const DEFAULT_JOB_TIMEOUT_MS = 45 * 60 * 1000;
const JOB_EXPIRY_GRACE_SECONDS = 15 * 60;

export function createAutorecoveryJob(
  options: {
    apiKey?: string | null;
    run?: (signal: AbortSignal) => Promise<number>;
    jobTimeoutMs?: number;
  } = {},
): JobDefinition {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  const run = options.run ?? tickAutorecovery;
  const jobTimeoutMs = options.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
  return {
    name: "autorecovery",
    schedule: "*/5 * * * *",
    // Cancel active external I/O before the durable lease can expire. The
    // remaining grace covers fast DB/Slack cleanup without permitting a
    // second exclusive pass to overlap the first one.
    expireInSeconds: Math.ceil(jobTimeoutMs / 1000) + JOB_EXPIRY_GRACE_SECONDS,
    create: () => {
      if (!apiKey?.trim()) return null;
      return async () => {
        await run(AbortSignal.timeout(jobTimeoutMs));
      };
    },
  };
}

export const job = createAutorecoveryJob();
