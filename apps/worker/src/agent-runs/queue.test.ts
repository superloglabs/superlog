import assert from "node:assert/strict";
import { test } from "node:test";
import type { schema } from "@superlog/db";
import {
  AGENT_RUN_ADVANCE_QUEUE,
  AGENT_RUN_SWEEP_QUEUE,
  type AgentRunQueueBoss,
  type AgentRunQueueDeps,
  createAgentRunJobSender,
  registerAgentRunQueue,
} from "./queue.js";

type SentJob = { name: string; data: unknown; options: unknown };
type InsertedJob = { name: string; jobs: Array<Record<string, unknown>> };
type WorkHandler = (jobs: Array<{ id: string; data: unknown }>) => Promise<unknown>;

function fakeBoss() {
  const sent: SentJob[] = [];
  const inserted: InsertedJob[] = [];
  const queues: Array<{ name: string; options: unknown }> = [];
  const schedules: Array<{ name: string; cron: string }> = [];
  const workers = new Map<string, WorkHandler>();
  const ops: string[] = [];
  const boss: AgentRunQueueBoss = {
    async createQueue(name, options) {
      ops.push(`createQueue:${name}`);
      queues.push({ name, options });
    },
    async work(name, _options, handler) {
      ops.push(`work:${name}`);
      workers.set(name, handler as WorkHandler);
    },
    async send(name, data, options) {
      sent.push({ name, data, options });
      return "job-id";
    },
    async insert(name, jobs) {
      inserted.push({ name, jobs: jobs as Array<Record<string, unknown>> });
      return [];
    },
    async schedule(name, cron) {
      ops.push(`schedule:${name}`);
      schedules.push({ name, cron });
    },
  };
  return { boss, sent, inserted, queues, schedules, workers, ops };
}

function runOf(id: string, state: string): schema.AgentRun {
  return { id, state } as schema.AgentRun;
}

function contextOf(run: schema.AgentRun): { agentRun: schema.AgentRun } {
  return { agentRun: run };
}

type DepsOverrides = Omit<Partial<AgentRunQueueDeps>, "handlers"> & {
  handlers?: Partial<AgentRunQueueDeps["handlers"]>;
};

function makeDeps(overrides: DepsOverrides = {}) {
  const calls: string[] = [];
  const handler = (name: string) => async () => {
    calls.push(name);
  };
  const deps: AgentRunQueueDeps = {
    loadRun: overrides.loadRun ?? (async (id) => runOf(id, "queued")),
    loadContext:
      overrides.loadContext ??
      (async (run) => contextOf(run) as Awaited<ReturnType<AgentRunQueueDeps["loadContext"]>>),
    failContextUnavailable:
      overrides.failContextUnavailable ??
      (async () => {
        calls.push("fail_context_unavailable");
      }),
    listActiveRunIds: overrides.listActiveRunIds ?? (async () => []),
    handlers: {
      start: overrides.handlers?.start ?? handler("start"),
      sync: overrides.handlers?.sync ?? handler("sync"),
      resume: overrides.handlers?.resume ?? handler("resume"),
      retryPrDelivery: overrides.handlers?.retryPrDelivery ?? handler("retry_pr_delivery"),
    },
    logger: { warn: () => {}, error: () => {} },
  };
  return { deps, calls };
}

test("registration creates both queues, workers, and the sweep schedule", async () => {
  const fb = fakeBoss();
  const { deps } = makeDeps();
  await registerAgentRunQueue(fb.boss, deps);

  const advance = fb.queues.find((q) => q.name === AGENT_RUN_ADVANCE_QUEUE);
  // `stately` allows one queued + one active job per run id, so an
  // event-driven enqueue during processing is preserved while duplicates
  // still collapse.
  assert.deepEqual(advance?.options, { policy: "stately" });
  const sweep = fb.queues.find((q) => q.name === AGENT_RUN_SWEEP_QUEUE);
  assert.deepEqual(sweep?.options, { policy: "exclusive" });
  assert.ok(fb.workers.get(AGENT_RUN_ADVANCE_QUEUE));
  assert.ok(fb.workers.get(AGENT_RUN_SWEEP_QUEUE));
  assert.deepEqual(fb.schedules, [{ name: AGENT_RUN_SWEEP_QUEUE, cron: "* * * * *" }]);
  // The advance consumer must be registered LAST: the caller enables the
  // tick's batch-rotation fallback when registration throws, so a partial
  // failure must never leave a live advance consumer behind — that would
  // advance the same run from two places at once.
  assert.equal(fb.ops.at(-1), `work:${AGENT_RUN_ADVANCE_QUEUE}`);
});

test("advance worker dispatches by run state", async () => {
  const states: Array<[string, string]> = [
    ["queued", "start"],
    ["repo_discovery", "start"],
    ["running", "sync"],
    ["awaiting_human", "resume"],
    ["awaiting_events", "resume"],
    ["resuming", "resume"],
    ["pr_retry_queued", "retry_pr_delivery"],
  ];
  for (const [state, expected] of states) {
    const fb = fakeBoss();
    const { deps, calls } = makeDeps({ loadRun: async (id) => runOf(id, state) });
    await registerAgentRunQueue(fb.boss, deps);
    const worker = fb.workers.get(AGENT_RUN_ADVANCE_QUEUE);
    assert.ok(worker);
    await worker([{ id: "job-1", data: { agentRunId: "run-1" } }]);
    assert.deepEqual(calls, [expected], `state ${state} must dispatch ${expected}`);
  }
});

test("advance worker skips missing runs, terminal states, and malformed jobs", async () => {
  const fb = fakeBoss();
  const { deps, calls } = makeDeps({
    loadRun: async (id) =>
      id === "gone" ? null : runOf(id, id === "done" ? "complete" : "queued"),
  });
  await registerAgentRunQueue(fb.boss, deps);
  const worker = fb.workers.get(AGENT_RUN_ADVANCE_QUEUE);
  assert.ok(worker);

  await worker([
    { id: "job-1", data: { agentRunId: "gone" } },
    { id: "job-2", data: { agentRunId: "done" } },
    { id: "job-3", data: { nonsense: true } },
  ]);

  assert.deepEqual(calls, [], "no handler may run for missing/terminal/malformed jobs");
});

test("a run whose incident or project is gone is failed as context_unavailable", async () => {
  const fb = fakeBoss();
  const failed: string[] = [];
  const { deps, calls } = makeDeps({
    loadContext: async () => null,
    failContextUnavailable: async (run) => {
      failed.push(run.id);
    },
  });
  await registerAgentRunQueue(fb.boss, deps);
  const worker = fb.workers.get(AGENT_RUN_ADVANCE_QUEUE);
  assert.ok(worker);

  await worker([{ id: "job-1", data: { agentRunId: "run-1" } }]);

  assert.deepEqual(failed, ["run-1"]);
  assert.deepEqual(calls, []);
});

test("one job's failure is swallowed and the rest of the batch still runs", async () => {
  const fb = fakeBoss();
  const { deps, calls } = makeDeps({
    handlers: {
      start: async () => {
        throw new Error("boom");
      },
    },
    loadRun: async (id) => runOf(id, id === "poison" ? "queued" : "running"),
  });
  await registerAgentRunQueue(fb.boss, deps);
  const worker = fb.workers.get(AGENT_RUN_ADVANCE_QUEUE);
  assert.ok(worker);

  await worker([
    { id: "job-1", data: { agentRunId: "poison" } },
    { id: "job-2", data: { agentRunId: "run-2" } },
  ]);

  assert.deepEqual(calls, ["sync"], "the healthy job must still be processed");
});

test("sweep enqueues one deduped advance job per active run", async () => {
  const fb = fakeBoss();
  const { deps } = makeDeps({ listActiveRunIds: async () => ["run-1", "run-2"] });
  await registerAgentRunQueue(fb.boss, deps);
  const sweep = fb.workers.get(AGENT_RUN_SWEEP_QUEUE);
  assert.ok(sweep);

  await sweep([{ id: "sweep-1", data: {} }]);

  assert.equal(fb.inserted.length, 1);
  assert.equal(fb.inserted[0]?.name, AGENT_RUN_ADVANCE_QUEUE);
  assert.deepEqual(fb.inserted[0]?.jobs, [
    { data: { agentRunId: "run-1" }, singletonKey: "run-1" },
    { data: { agentRunId: "run-2" }, singletonKey: "run-2" },
  ]);
});

test("the job sender enqueues with a per-run singleton key and never throws", async () => {
  const fb = fakeBoss();
  const send = createAgentRunJobSender(fb.boss, { warn: () => {}, error: () => {} });

  await send("run-1");
  assert.deepEqual(fb.sent, [
    {
      name: AGENT_RUN_ADVANCE_QUEUE,
      data: { agentRunId: "run-1" },
      options: { singletonKey: "run-1" },
    },
  ]);

  const failing = createAgentRunJobSender(
    {
      ...fb.boss,
      async send() {
        throw new Error("pg-boss unavailable");
      },
    },
    { warn: () => {}, error: () => {} },
  );
  await failing("run-2"); // must not throw — the sweep re-enqueues within a minute
});
