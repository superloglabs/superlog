// Allow enough time for in-flight advance jobs to reach their internal 180 s
// timeout before the pg-boss graceful stop force-expires them. If the boss
// stops before the handler returns, pg-boss leaves the job in `active` state
// for up to its queue-level expireInSeconds (currently 210 s), blocking the
// next pending job for that run via the stately policy. Giving the drain
// 200 s lets the internal timeout fire first, completing the pg-boss job
// cleanly and avoiding the orphaned-active-job backlog during deployments.
// NOTE: the deployment's container stopTimeout must exceed this value.
const DEFAULT_JOB_DRAIN_TIMEOUT_MS = 200_000;

type JobRunner = {
  stop(options: { graceful: boolean; timeout: number }): Promise<void>;
};

export async function drainWorker(deps: {
  stopTickLoop(): void;
  tickLoop: Promise<void>;
  jobRunner: JobRunner | null;
  closeClickHouse(): Promise<void>;
  jobDrainTimeoutMs?: number;
}): Promise<void> {
  deps.stopTickLoop();
  const results = await Promise.allSettled([
    deps.tickLoop,
    deps.jobRunner?.stop({
      graceful: true,
      timeout: deps.jobDrainTimeoutMs ?? DEFAULT_JOB_DRAIN_TIMEOUT_MS,
    }),
  ]);
  await deps.closeClickHouse();

  const failures = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  const [failure] = failures;
  if (failures.length === 1 && failure) throw failure.reason;
  if (failures.length > 1) {
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      "worker drain failed",
    );
  }
}

export async function shutdownWorkerProcess(deps: {
  drain(): Promise<void>;
  shutdownAnalytics(): Promise<void>;
  shutdownTelemetry(): Promise<void>;
  onError(phase: string, error: unknown): void;
}): Promise<0 | 1> {
  let failed = false;
  const phases: Array<[string, () => Promise<void>]> = [
    ["drain", deps.drain],
    ["analytics", deps.shutdownAnalytics],
    ["telemetry", deps.shutdownTelemetry],
  ];
  for (const [phase, run] of phases) {
    try {
      await run();
    } catch (error) {
      failed = true;
      deps.onError(phase, error);
    }
  }
  return failed ? 1 : 0;
}
