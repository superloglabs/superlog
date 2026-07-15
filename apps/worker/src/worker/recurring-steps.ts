// The former tick steps as recurring pg-boss chains (see recurring.ts for the
// mechanism). Intervals preserve each step's effective cadence from the tick
// era: sub-minute for latency-sensitive sweeps (webhook delivery, alert
// evaluation, agent chats), a minute for the sweeps that gate themselves
// internally (digests' per-org cadence, observation windows). Steps whose
// intrinsic cadence is a minute or slower (autorecovery, usage metering) live
// in the jobs dir as cron jobs instead.
import { tickAgentChats } from "../agent-chats/tick.js";
import { tickAlerts } from "../alerts.js";
import { tickDigests } from "../digest.js";
import type { handleIssueTransition } from "../incidents/workflow.js";
import { logger as defaultLogger } from "../logger.js";
import { tickObservedIssues } from "../observation.js";
import { loadQueueHealthCounts } from "../queue-health.js";
import { tickWebhooks } from "../webhooks.js";
import {
  type ChainCounts,
  type RecurringBoss,
  type RecurringStep,
  registerRecurringReviver,
  registerRecurringStep,
} from "./recurring.js";
import type { SkippableTickStep } from "./tick.js";

type ClickHouseClientLike = Parameters<typeof tickAlerts>[0];
type LoggerLike = Pick<typeof defaultLogger, "info" | "warn" | "error">;

export type RecurringStepsDeps = {
  clickhouse: ClickHouseClientLike;
  onIssueTransition: typeof handleIssueTransition;
};

export type RecurringStepSpec = RecurringStep & {
  // The tick step this chain replaces.
  tickStep: SkippableTickStep;
};

// Every tick step owned by a recurring chain. The caller skips ALL of these
// in the tick whenever pg-boss is up — even a step whose own registration
// failed. Falling back locally would run the step concurrently with another
// process's live chain (double webhook deliveries, duplicate transitions), so
// a failed step is instead dormant on this process while its registration is
// retried in the background (below) until it succeeds: a transient failure
// heals within a minute, and a persistent one logs an error on every attempt
// while stuck-queue alerting catches a queue left without any consumer.
export const RECURRING_TICK_STEPS: readonly SkippableTickStep[] = [
  "agent_chats",
  "webhooks",
  "alerts",
  "digests",
  "observation",
];

const REGISTRATION_RETRY_MS = 60_000;

export function buildRecurringSteps(deps: RecurringStepsDeps): RecurringStepSpec[] {
  return [
    {
      queue: "agent-chat-sweep",
      tickStep: "agent_chats",
      intervalSeconds: 5,
      run: tickAgentChats,
      // A pass may legitimately start provider sessions for a whole batch of
      // chats; only warn once it runs well past that.
      passWarnAfterMs: 600_000,
    },
    {
      queue: "webhook-deliveries",
      tickStep: "webhooks",
      intervalSeconds: 5,
      run: () => tickWebhooks(),
    },
    {
      queue: "alert-evaluation",
      tickStep: "alerts",
      intervalSeconds: 10,
      run: () => tickAlerts(deps.clickhouse, deps.onIssueTransition),
    },
    {
      queue: "digest-sweep",
      tickStep: "digests",
      intervalSeconds: 60,
      run: tickDigests,
      // LLM ranking per due org can stack up on the daily boundary.
      passWarnAfterMs: 900_000,
    },
    {
      queue: "observation-sweep",
      tickStep: "observation",
      intervalSeconds: 60,
      run: () => tickObservedIssues(deps.onIssueTransition),
    },
  ];
}

export type StartRecurringStepsOptions = {
  logger?: LoggerLike;
  retryDelayMs?: number;
  // Threaded through to every step's pass (see RegisterRecurringStepOptions);
  // also stops the background registration retry on a draining process.
  shutdown?: AbortSignal;
  // Test seam; defaults to the queue-health loader.
  loadChainCounts?: () => Promise<ChainCounts[]>;
};

// Register every step's chain, one failure at a time: one step's registration
// failure must not block the others. A failed step is never run locally (see
// RECURRING_TICK_STEPS); instead its registration keeps retrying in the
// background — sequential attempts via a self-scheduling timeout, so two
// attempts can't race a consumer onto the queue twice. Registration is
// idempotent (createQueue/updateQueue upsert, the seed send dedupes on the
// chain key), which is what makes the retry safe after a partial failure.
// Returns the steps that registered on the first attempt.
export async function startRecurringSteps(
  boss: RecurringBoss,
  deps: RecurringStepsDeps,
  opts: StartRecurringStepsOptions = {},
): Promise<Set<SkippableTickStep>> {
  const logger = opts.logger ?? defaultLogger;
  const retryDelayMs = opts.retryDelayMs ?? REGISTRATION_RETRY_MS;
  const migrated = new Set<SkippableTickStep>();
  for (const step of buildRecurringSteps(deps)) {
    const attempt = async (): Promise<boolean> => {
      try {
        await registerRecurringStep(boss, step, { logger, shutdown: opts.shutdown });
        migrated.add(step.tickStep);
        return true;
      } catch (err) {
        logger.error(
          {
            scope: "worker.recurring",
            step: step.queue,
            err: err instanceof Error ? err.message : String(err),
          },
          "recurring step failed to register; dormant on this process, retrying in the background",
        );
        return false;
      }
    };
    const scheduleRetry = (): void => {
      const timer = setTimeout(async () => {
        if (opts.shutdown?.aborted) return;
        if (!(await attempt())) scheduleRetry();
      }, retryDelayMs);
      timer.unref?.();
    };
    if (!(await attempt())) scheduleRetry();
  }

  // The shared dead-chain reviver (see recurring.ts). Its own failure is
  // non-fatal: every healthy chain self-perpetuates without it; it only
  // narrows the crash window between a pass and its reschedule.
  try {
    const loadCounts = opts.loadChainCounts ?? loadQueueHealthCounts;
    await registerRecurringReviver(boss, buildRecurringSteps(deps), loadCounts, logger);
  } catch (err) {
    logger.error(
      { scope: "worker.recurring", err: err instanceof Error ? err.message : String(err) },
      "recurring reviver failed to register; chains rely on their own rescheduling",
    );
  }
  return migrated;
}
