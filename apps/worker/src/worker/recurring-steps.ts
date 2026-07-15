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
import { tickWebhooks } from "../webhooks.js";
import { type RecurringBoss, type RecurringStep, registerRecurringStep } from "./recurring.js";
import type { SkippableTickStep } from "./tick.js";

type ClickHouseClientLike = Parameters<typeof tickAlerts>[0];
type LoggerLike = Pick<typeof defaultLogger, "info" | "warn" | "error">;

export type RecurringStepsDeps = {
  clickhouse: ClickHouseClientLike;
  onIssueTransition: typeof handleIssueTransition;
};

export type RecurringStepSpec = RecurringStep & {
  // The tick step this chain replaces; the caller skips it in the tick loop
  // once the chain is registered.
  tickStep: SkippableTickStep;
};

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

// Register every step's chain, one failure at a time: a step whose
// registration throws stays in the tick loop (degraded cadence, still
// running); the rest migrate. Returns the set of migrated tick steps for the
// caller to skip.
export async function startRecurringSteps(
  boss: RecurringBoss,
  deps: RecurringStepsDeps,
  logger: LoggerLike = defaultLogger,
): Promise<Set<SkippableTickStep>> {
  const migrated = new Set<SkippableTickStep>();
  for (const step of buildRecurringSteps(deps)) {
    try {
      await registerRecurringStep(boss, step, logger);
      migrated.add(step.tickStep);
    } catch (err) {
      logger.error(
        {
          scope: "worker.recurring",
          step: step.queue,
          err: err instanceof Error ? err.message : String(err),
        },
        "recurring step failed to register; it stays in the tick loop",
      );
    }
  }
  return migrated;
}
