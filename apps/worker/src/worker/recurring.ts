// Self-rescheduling pg-boss chains for the worker's recurring steps.
//
// Previously these steps ran inside the single sequential tick loop, so one
// slow or wedged step delayed every other step's cadence. Here each step gets
// its own queue and advances as a chain: a pass runs, then sends the queue its
// next job with `startAfter = intervalSeconds`. pg-boss cron can't go below a
// minute, which is why sub-minute steps (webhook delivery, alert evaluation)
// self-schedule instead of joining the cron jobs in the jobs dir.
//
// Liveness has two layers:
//   - The chain itself: every pass reschedules in `finally`, so a failed pass
//     still continues the chain (each pass is an idempotent sweep — "retrying"
//     a failure IS the next pass, which is why the queue sets retryLimit 0).
//   - A minute cron reviver per queue: if the chain dies anyway (process crash
//     between a pass completing and its reschedule landing), the cron's send
//     re-seeds it. On a healthy chain the send collapses against the queued
//     successor via the singleton key.
//
// Passes never overlap, across processes included: the `stately` policy plus
// one fixed singleton key allows at most one ACTIVE job per queue anywhere in
// the fleet, and the job is held active until its pass fully settles — a slow
// pass is logged past its warn deadline but never abandoned, because each
// step now owns its queue and a wedged pass can only stall itself. The escape
// hatch is pg-boss job expiry (`expireInSeconds`): a crashed process's active
// job is failed after that bound, unblocking the reviver's queued successor.
// Expiry is also the residual overlap window — a pass still running past it
// on a live process could overlap its successor — so it is derived as a
// comfortable multiple of the warn deadline, far above what the steps'
// underlying HTTP/SDK timeouts allow a pass to reach.
import { logger as defaultLogger } from "../logger.js";

export const RECURRING_CHAIN_KEY = "chain";
const REVIVER_SCHEDULE = "* * * * *";

// Soft deadline: a pass running longer than this is logged (it shows up next
// to the queue-health lines for alerting) but keeps running.
const DEFAULT_PASS_WARN_AFTER_MS = 300_000;
const MIN_EXPIRE_SECONDS = 600;

// How long pg-boss lets a job sit active before failing it. Doubles as crash
// recovery latency (a dead process's job frees the chain after this) and as
// the no-overlap guarantee's bound (see header) — hence a multiple of the
// warn deadline with a floor.
export function passExpireSeconds(warnAfterMs: number): number {
  return Math.max(MIN_EXPIRE_SECONDS, Math.ceil((warnAfterMs * 2) / 1000));
}

export type RecurringBoss = {
  createQueue(name: string, options?: unknown): Promise<unknown>;
  updateQueue(name: string, options?: unknown): Promise<unknown>;
  work(
    name: string,
    options: { batchSize: number },
    handler: (jobs: Array<{ id: string; data: unknown }>) => Promise<unknown>,
  ): Promise<unknown>;
  send(name: string, data: object, options?: object): Promise<unknown>;
  schedule(name: string, cron: string, data?: unknown, options?: unknown): Promise<unknown>;
};

type LoggerLike = Pick<typeof defaultLogger, "info" | "warn" | "error">;

export type RecurringStep = {
  // Queue name; also the step's identity in queue-health metrics and logs.
  queue: string;
  // Pause between the end of one pass and the start of the next.
  intervalSeconds: number;
  // One pass. Must be safe to call again after a failure (every step here is
  // a cursor- or state-driven sweep, so a pass picks up whatever the previous
  // one left).
  run: () => Promise<unknown>;
  passWarnAfterMs?: number;
};

export type RegisterRecurringStepOptions = {
  logger?: LoggerLike;
  // Aborted when the process starts draining (SIGTERM). An in-flight pass is
  // then handed back: the handler resolves so pg-boss completes the job and
  // the reschedule lands, instead of the process dying with the job still
  // ACTIVE — which would leave the stately singleton blocking every other
  // process's chain until job expiry (up to tens of minutes for the
  // long-lease steps). The abandoned pass keeps running only until the
  // process exits, so the residual overlap window is bounded by the drain
  // timeout — the same window the tick loop had on deploys.
  shutdown?: AbortSignal;
};

// Register one step's chain. The consumer comes LAST so a partial
// registration never leaves a live consumer on a half-configured queue;
// everything else a partial registration can leave behind (queue, reviver
// cron, seed job) is inert without a consumer and gets drained by the next
// healthy boot. A step whose registration throws is dormant on this process —
// the caller must NOT run it anywhere else, because another process's chain
// may be live (see recurring-steps.ts).
export async function registerRecurringStep(
  boss: RecurringBoss,
  step: RecurringStep,
  opts: RegisterRecurringStepOptions = {},
): Promise<void> {
  const logger = opts.logger ?? defaultLogger;
  const shutdown = opts.shutdown;
  const warnAfterMs = step.passWarnAfterMs ?? DEFAULT_PASS_WARN_AFTER_MS;
  const lease = { retryLimit: 0, expireInSeconds: passExpireSeconds(warnAfterMs) };

  await boss.createQueue(step.queue, { policy: "stately", ...lease });
  // createQueue does not update an existing queue (same as jobs/runner.ts):
  // keep the mutable lease settings in sync across deploys while leaving the
  // immutable policy on the create path.
  await boss.updateQueue(step.queue, lease);
  await boss.schedule(step.queue, REVIVER_SCHEDULE, {}, { singletonKey: RECURRING_CHAIN_KEY });
  await boss.send(step.queue, {}, { singletonKey: RECURRING_CHAIN_KEY });

  await boss.work(step.queue, { batchSize: 1 }, async () => {
    try {
      // Don't start new work on a draining process; the successor scheduled
      // below runs on whichever process is alive after the deploy.
      if (!shutdown?.aborted) await runPassToSettlement();
    } finally {
      // Reschedule unconditionally — the chain must survive pass failures. A
      // send failure is only logged: the minute reviver restores the chain.
      try {
        await boss.send(
          step.queue,
          {},
          { startAfter: step.intervalSeconds, singletonKey: RECURRING_CHAIN_KEY },
        );
      } catch (err) {
        logger.error(
          {
            scope: "worker.recurring",
            step: step.queue,
            err: err instanceof Error ? err.message : String(err),
          },
          "failed to reschedule recurring step; the reviver cron restores it within a minute",
        );
      }
    }
  });

  // Run one pass and hold the pg-boss job active until it settles — that hold
  // is what blocks the successor fleet-wide (see header). Errors are logged
  // and swallowed: the next pass is the retry. The one exception to the hold
  // is process shutdown (see RegisterRecurringStepOptions.shutdown).
  async function runPassToSettlement(): Promise<void> {
    const warnTimer = setTimeout(() => {
      logger.warn(
        { scope: "worker.recurring", step: step.queue, warn_after_ms: warnAfterMs },
        "recurring step pass running past its deadline; the chain waits for it",
      );
    }, warnAfterMs);
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<"aborted">((resolve) => {
      if (!shutdown) return; // never resolves
      onAbort = () => resolve("aborted");
      if (shutdown.aborted) onAbort();
      else shutdown.addEventListener("abort", onAbort, { once: true });
    });
    const pass = Promise.resolve()
      .then(step.run)
      .then(() => "done" as const)
      .catch((err) => {
        logger.error(
          {
            scope: "worker.recurring",
            step: step.queue,
            err: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          },
          "recurring step pass failed",
        );
        return "done" as const;
      });
    try {
      const outcome = await Promise.race([pass, aborted]);
      if (outcome === "aborted") {
        logger.warn(
          { scope: "worker.recurring", step: step.queue },
          "abandoning in-flight pass for shutdown; the successor resumes after the deploy",
        );
      }
    } finally {
      clearTimeout(warnTimer);
      if (onAbort) shutdown?.removeEventListener("abort", onAbort);
    }
  }
}
