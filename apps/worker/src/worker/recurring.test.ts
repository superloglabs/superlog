import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ChainCounts,
  RECURRING_CHAIN_KEY,
  RECURRING_REVIVER_QUEUE,
  type RecurringBoss,
  type RecurringStep,
  passExpireSeconds,
  registerRecurringReviver,
  registerRecurringStep,
} from "./recurring.js";

type SentJob = { name: string; data: unknown; options: Record<string, unknown> | undefined };
type WorkHandler = (jobs: Array<{ id: string; data: unknown }>) => Promise<unknown>;

function fakeBoss() {
  const sent: SentJob[] = [];
  const queues: Array<{ name: string; options: unknown }> = [];
  const queueUpdates: Array<{ name: string; options: unknown }> = [];
  const schedules: Array<{ name: string; cron: string; options: unknown }> = [];
  const workers = new Map<string, WorkHandler>();
  const workOptions = new Map<string, unknown>();
  const ops: string[] = [];
  const boss: RecurringBoss = {
    async createQueue(name, options) {
      ops.push(`createQueue:${name}`);
      queues.push({ name, options });
    },
    async updateQueue(name, options) {
      ops.push(`updateQueue:${name}`);
      queueUpdates.push({ name, options });
    },
    async work(name, options, handler) {
      ops.push(`work:${name}`);
      workers.set(name, handler as WorkHandler);
      workOptions.set(name, options);
    },
    async send(name, data, options) {
      ops.push(`send:${name}`);
      sent.push({ name, data, options: options as Record<string, unknown> | undefined });
      return "job-id";
    },
    async schedule(name, cron, _data, options) {
      ops.push(`schedule:${name}`);
      schedules.push({ name, cron, options });
    },
    async unschedule(name) {
      ops.push(`unschedule:${name}`);
    },
  };
  return { boss, sent, queues, queueUpdates, schedules, workers, workOptions, ops };
}

const quietLogger = { info: () => {}, warn: () => {}, error: () => {} };

function stepOf(overrides: Partial<RecurringStep> = {}): RecurringStep {
  return {
    queue: "test-step",
    intervalSeconds: 5,
    run: async () => {},
    ...overrides,
  };
}

test("registration creates a stately queue, a seed job, and the consumer last", async () => {
  const fb = fakeBoss();
  await registerRecurringStep(fb.boss, stepOf(), { logger: quietLogger });

  // `stately` allows one queued + one active job per singleton key: the
  // running pass and its already-scheduled successor coexist, while reviver
  // sends collapse against the queued successor. No pg-boss retries — the
  // chain's next pass IS the retry — and a bounded expiry so a crashed
  // process's active job frees the chain instead of wedging it.
  const lease = { retryLimit: 0, expireInSeconds: passExpireSeconds(300_000) };
  assert.deepEqual(fb.queues, [{ name: "test-step", options: { policy: "stately", ...lease } }]);
  // createQueue never updates an existing queue, so the mutable lease
  // settings must also be pushed through updateQueue to reach queues created
  // by earlier deploys.
  assert.deepEqual(fb.queueUpdates, [{ name: "test-step", options: lease }]);

  // No per-queue cron: an unconditional minute seed parks a pending job
  // behind a long-but-healthy active pass (false stuck-queue alerts) — dead
  // chains are revived by the shared reviver instead, and the legacy
  // per-queue schedule row is removed from earlier revisions.
  assert.deepEqual(fb.schedules, []);
  assert.ok(fb.ops.includes("unschedule:test-step"));

  // The seed starts the chain immediately at boot.
  assert.deepEqual(fb.sent, [
    { name: "test-step", data: {}, options: { singletonKey: RECURRING_CHAIN_KEY } },
  ]);

  assert.deepEqual(fb.workOptions.get("test-step"), { batchSize: 1 });

  // The consumer is registered LAST so a partial registration never leaves a
  // live consumer on a half-configured queue.
  assert.equal(fb.ops.at(-1), "work:test-step");
});

test("the reviver seeds only dead chains", async () => {
  const fb = fakeBoss();
  const counts: ChainCounts[] = [
    { queue: "busy-step", pending: 0, active: 1 }, // long pass in flight
    { queue: "waiting-step", pending: 1, active: 0 }, // successor scheduled
    { queue: "drained-step", pending: 0, active: 0 }, // dead
    // "missing-step" absent entirely — also dead
  ];
  await registerRecurringReviver(
    fb.boss,
    [
      { queue: "busy-step" },
      { queue: "waiting-step" },
      { queue: "drained-step" },
      { queue: "missing-step" },
    ],
    async () => counts,
    quietLogger,
  );

  assert.deepEqual(fb.queues, [
    { name: RECURRING_REVIVER_QUEUE, options: { policy: "exclusive" } },
  ]);
  assert.equal(fb.schedules[0]?.name, RECURRING_REVIVER_QUEUE);
  assert.equal(fb.schedules[0]?.cron, "* * * * *");
  const reviver = fb.workers.get(RECURRING_REVIVER_QUEUE);
  assert.ok(reviver);

  await reviver([{ id: "revive-1", data: {} }]);

  // A chain with an active pass or a queued successor must NOT get a seed —
  // that pending job would age behind the pass and trip stuck-queue alerts.
  assert.deepEqual(
    fb.sent.map((s) => [s.name, s.options]),
    [
      ["drained-step", { singletonKey: RECURRING_CHAIN_KEY }],
      ["missing-step", { singletonKey: RECURRING_CHAIN_KEY }],
    ],
  );
});

test("a reviver counts-load failure is swallowed and retried next minute", async () => {
  const fb = fakeBoss();
  await registerRecurringReviver(
    fb.boss,
    [{ queue: "some-step" }],
    async () => {
      throw new Error("pg down");
    },
    quietLogger,
  );
  const reviver = fb.workers.get(RECURRING_REVIVER_QUEUE);
  assert.ok(reviver);

  await reviver([{ id: "revive-1", data: {} }]); // must not throw

  assert.deepEqual(fb.sent, [], "nothing may be seeded on unknown chain state");
});

test("expiry stays a comfortable multiple of the warn deadline, with a floor", () => {
  // A pass legitimately running past its warn deadline must not have its job
  // expired out from under it (expiry is what re-opens the overlap window).
  assert.equal(passExpireSeconds(300_000), 600);
  assert.equal(passExpireSeconds(900_000), 1800);
  // Short warn deadlines still keep the floor so a brief pg-boss maintenance
  // hiccup can't expire a healthy pass.
  assert.equal(passExpireSeconds(10_000), 600);
});

test("a completed pass reschedules itself after the interval", async () => {
  const fb = fakeBoss();
  let passes = 0;
  await registerRecurringStep(
    fb.boss,
    stepOf({
      intervalSeconds: 7,
      run: async () => {
        passes += 1;
      },
    }),
    { logger: quietLogger },
  );
  const worker = fb.workers.get("test-step");
  assert.ok(worker);
  fb.sent.length = 0; // drop the seed

  await worker([{ id: "job-1", data: {} }]);

  assert.equal(passes, 1);
  assert.deepEqual(fb.sent, [
    {
      name: "test-step",
      data: {},
      options: { startAfter: 7, singletonKey: RECURRING_CHAIN_KEY },
    },
  ]);
});

test("a failing pass is logged and still reschedules", async () => {
  const fb = fakeBoss();
  const errors: string[] = [];
  await registerRecurringStep(
    fb.boss,
    stepOf({
      run: async () => {
        throw new Error("pass exploded");
      },
    }),
    {
      logger: {
        ...quietLogger,
        error: (...args: unknown[]) => {
          errors.push(String(args[1]));
        },
      },
    },
  );
  const worker = fb.workers.get("test-step");
  assert.ok(worker);
  fb.sent.length = 0;

  await worker([{ id: "job-1", data: {} }]); // must not throw

  assert.ok(errors.length >= 1, "the failure must be logged");
  assert.equal(fb.sent.length, 1, "the chain must continue past a failed pass");
});

test("the job stays active until the pass settles — a slow pass warns but is never abandoned", async () => {
  const fb = fakeBoss();
  const warnings: string[] = [];
  let releaseHung: (() => void) | undefined;
  const hung = new Promise<void>((resolve) => {
    releaseHung = resolve;
  });
  await registerRecurringStep(fb.boss, stepOf({ run: () => hung, passWarnAfterMs: 5 }), {
    logger: {
      ...quietLogger,
      warn: (...args: unknown[]) => {
        warnings.push(String(args[1]));
      },
    },
  });
  const worker = fb.workers.get("test-step");
  assert.ok(worker);
  fb.sent.length = 0;

  // Holding the job active while the pass runs is the cross-process overlap
  // guard: pg-boss (stately + singleton key) blocks the successor everywhere
  // until this handler resolves. So the handler must NOT resolve early.
  let handlerSettled = false;
  const handlerRun = worker([{ id: "job-1", data: {} }]).then(() => {
    handlerSettled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(handlerSettled, false, "the handler must wait for the pass");
  assert.ok(
    warnings.some((m) => m.includes("deadline")),
    "a pass running past its warn deadline must be logged",
  );
  assert.equal(fb.sent.length, 0, "no successor may be scheduled while the pass runs");

  releaseHung?.();
  await handlerRun;
  assert.equal(fb.sent.length, 1, "the chain continues once the pass settles");
});

test("a reschedule failure is swallowed — the reviver cron restores the chain", async () => {
  const fb = fakeBoss();
  let seeded = false;
  fb.boss.send = async () => {
    if (!seeded) {
      seeded = true;
      return "seed";
    }
    throw new Error("pg down");
  };
  await registerRecurringStep(fb.boss, stepOf(), { logger: quietLogger });
  const worker = fb.workers.get("test-step");
  assert.ok(worker);

  await worker([{ id: "job-1", data: {} }]); // must not throw
});

test("shutdown hands an in-flight pass back so the job completes and reschedules", async () => {
  const fb = fakeBoss();
  const shutdown = new AbortController();
  const never = new Promise<void>(() => {});
  await registerRecurringStep(fb.boss, stepOf({ run: () => never }), {
    logger: quietLogger,
    shutdown: shutdown.signal,
  });
  const worker = fb.workers.get("test-step");
  assert.ok(worker);
  fb.sent.length = 0;

  // The pass hangs; without the abort the handler would (correctly) wait
  // forever. On shutdown it must resolve — a process dying with the job still
  // ACTIVE would block the chain fleet-wide until job expiry.
  let handlerSettled = false;
  const handlerRun = worker([{ id: "job-1", data: {} }]).then(() => {
    handlerSettled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(handlerSettled, false);

  shutdown.abort();
  await handlerRun;
  assert.equal(fb.sent.length, 1, "the successor must still be scheduled");
});

test("no new pass starts on a draining process, but the chain still reschedules", async () => {
  const fb = fakeBoss();
  const shutdown = new AbortController();
  let passes = 0;
  await registerRecurringStep(
    fb.boss,
    stepOf({
      run: async () => {
        passes += 1;
      },
    }),
    { logger: quietLogger, shutdown: shutdown.signal },
  );
  const worker = fb.workers.get("test-step");
  assert.ok(worker);
  fb.sent.length = 0;

  shutdown.abort();
  await worker([{ id: "job-1", data: {} }]);

  assert.equal(passes, 0, "a draining process must not start new work");
  assert.equal(fb.sent.length, 1, "the successor runs on whichever process survives");
});
