// pg-boss execution for agent-run advancement.
//
// Previously every active run was advanced by a fixed-size batch inside the
// worker tick: each cycle selected the 20 stalest rows across all states and
// tenants and processed them sequentially. Under load the rotation interval
// grew with the size of the active set, so a backlog in one tenant delayed
// every other tenant's investigations by hours or days.
//
// Here each run advances as its own queue job:
//   - `agent-run-advance` holds one job per run (`stately` policy +
//     singletonKey = run id: at most one queued and one active per run).
//     Jobs in a fetch batch run concurrently, so wall-clock throughput no
//     longer depends on how many other runs exist.
//   - `agent-run-sweep` fires every minute and blind-enqueues every run in an
//     active state; the singleton key collapses duplicates. The sweep is both
//     the pickup for inbound events recorded outside this process (human
//     replies land as unprocessed incident_events rows) and the safety net
//     for lost jobs. Run creation additionally enqueues directly (see
//     enqueue.ts) so new investigations start in seconds, not at the next
//     sweep.
//
// Failure semantics match the old tick: a job's error is logged and swallowed
// (the handlers are not written to be safely re-runnable, so pg-boss retries
// stay out of the picture) and the next sweep re-enqueues the run.
import type { schema } from "@superlog/db";
import type { AgentRunContext } from "../agent-run-context.js";
import { logger as defaultLogger } from "../logger.js";

export const AGENT_RUN_ADVANCE_QUEUE = "agent-run-advance";
export const AGENT_RUN_SWEEP_QUEUE = "agent-run-sweep";
const SWEEP_SCHEDULE = "* * * * *";

// How many advance jobs a single fetch works on; batches run concurrently, so
// this is the effective per-process concurrency. Starting a run is dominated
// by provider/GitHub round-trips (IO-bound), so a moderate default drains a
// queued backlog far faster than the old one-batch-per-tick rotation without
// saturating the task.
const DEFAULT_CONCURRENCY = 10;
const MAX_CONCURRENCY = 50;

export type AgentRunQueueBoss = {
  createQueue(name: string, options?: unknown): Promise<unknown>;
  work(
    name: string,
    options: { batchSize: number },
    handler: (jobs: Array<{ id: string; data: unknown }>) => Promise<unknown>,
  ): Promise<unknown>;
  send(name: string, data: object, options?: object): Promise<unknown>;
  insert(name: string, jobs: object[]): Promise<unknown>;
  schedule(name: string, cron: string, data?: unknown, options?: unknown): Promise<unknown>;
};

type LoggerLike = Pick<typeof defaultLogger, "warn" | "error">;

export type AgentRunQueueDeps = {
  loadRun(id: string): Promise<schema.AgentRun | null | undefined>;
  loadContext(run: schema.AgentRun): Promise<AgentRunContext | null>;
  // Permanent condition (incident/project deleted): the run can never make
  // progress, so failing it is the only way it leaves the active set.
  failContextUnavailable(run: schema.AgentRun): Promise<void>;
  listActiveRunIds(): Promise<string[]>;
  handlers: {
    start(ctx: AgentRunContext): Promise<void>;
    sync(ctx: AgentRunContext): Promise<void>;
    resume(ctx: AgentRunContext): Promise<void>;
    retryPrDelivery(ctx: AgentRunContext): Promise<void>;
  };
  concurrency?: number;
  logger?: LoggerLike;
};

export type AgentRunJobData = { agentRunId: string };

function parseJobData(data: unknown): AgentRunJobData | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (typeof record.agentRunId !== "string") return null;
  return { agentRunId: record.agentRunId };
}

function clampConcurrency(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value) || value < 1) return DEFAULT_CONCURRENCY;
  return Math.min(value, MAX_CONCURRENCY);
}

async function advanceRun(deps: AgentRunQueueDeps, data: AgentRunJobData): Promise<void> {
  const agentRun = await deps.loadRun(data.agentRunId);
  if (!agentRun) return;
  const ctx = await deps.loadContext(agentRun);
  if (!ctx) {
    await deps.failContextUnavailable(agentRun);
    return;
  }
  const state = ctx.agentRun.state;
  if (state === "queued" || state === "repo_discovery") {
    await deps.handlers.start(ctx);
    return;
  }
  if (state === "running") {
    await deps.handlers.sync(ctx);
    return;
  }
  if (state === "awaiting_human" || state === "awaiting_events" || state === "resuming") {
    await deps.handlers.resume(ctx);
    return;
  }
  if (state === "pr_retry_queued") {
    await deps.handlers.retryPrDelivery(ctx);
  }
  // Terminal and dormant states: the job is stale (the run moved on between
  // enqueue and fetch) — nothing to do.
}

// Register both queues and their workers, plus the minute cron for the sweep.
//
// Ordering is load-bearing: the advance CONSUMER is registered last. When any
// call here throws, the caller (index.ts) falls back to the tick's batch
// rotation — if an advance consumer were already live at that point (it starts
// consuming leftover jobs from a previous boot immediately), the same run
// could be advanced concurrently from both paths. Failing before the final
// `work` leaves at most queues/cron/sweep behind, all of which are inert or
// idempotent without a consumer: sweep-inserted jobs sit deduped until a
// healthy boot picks them up, and each job reloads its run's current state.
export async function registerAgentRunQueue(
  boss: AgentRunQueueBoss,
  deps: AgentRunQueueDeps,
): Promise<void> {
  const logger = deps.logger ?? defaultLogger;
  const concurrency = clampConcurrency(deps.concurrency);

  await boss.createQueue(AGENT_RUN_ADVANCE_QUEUE, { policy: "stately" });
  await boss.createQueue(AGENT_RUN_SWEEP_QUEUE, { policy: "exclusive" });

  await boss.work(AGENT_RUN_SWEEP_QUEUE, { batchSize: 1 }, async () => {
    const ids = await deps.listActiveRunIds();
    if (ids.length === 0) return;
    await boss.insert(
      AGENT_RUN_ADVANCE_QUEUE,
      ids.map((id) => ({ data: { agentRunId: id } satisfies AgentRunJobData, singletonKey: id })),
    );
  });
  await boss.schedule(AGENT_RUN_SWEEP_QUEUE, SWEEP_SCHEDULE);

  await boss.work(AGENT_RUN_ADVANCE_QUEUE, { batchSize: concurrency }, async (jobs) => {
    await Promise.all(
      jobs.map(async (job) => {
        const data = parseJobData(job.data);
        if (!data) {
          logger.warn(
            { scope: "agent-run-queue", jobId: job.id },
            "skipping malformed agent-run job",
          );
          return;
        }
        try {
          await advanceRun(deps, data);
        } catch (err) {
          logger.error(
            {
              scope: "agent-run-queue",
              agent_run_id: data.agentRunId,
              err: err instanceof Error ? err.message : String(err),
            },
            "agent-run advance failed; the next sweep re-enqueues it",
          );
        }
      }),
    );
  });
}

// A send function for code that creates or touches a run and wants it
// advanced now rather than at the next sweep (run creation, steering). Send
// failures are logged and swallowed: the sweep re-enqueues within a minute,
// so an enqueue must never break the caller's transaction commit path.
export function createAgentRunJobSender(
  boss: Pick<AgentRunQueueBoss, "send">,
  logger: LoggerLike = defaultLogger,
): (agentRunId: string) => Promise<void> {
  return async (agentRunId) => {
    try {
      await boss.send(AGENT_RUN_ADVANCE_QUEUE, { agentRunId } satisfies AgentRunJobData, {
        singletonKey: agentRunId,
      });
    } catch (err) {
      logger.warn(
        {
          scope: "agent-run-queue",
          agent_run_id: agentRunId,
          err: err instanceof Error ? err.message : String(err),
        },
        "agent-run enqueue failed; the sweep will pick the run up",
      );
    }
  };
}
