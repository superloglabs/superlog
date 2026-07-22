import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoadedJob } from "../jobs.js";
import { type JobBoss, registerJobs } from "./runner.js";

type WorkHandler = (jobs: unknown[]) => Promise<unknown>;

function fakeBoss() {
  const calls: string[] = [];
  const queues: string[] = [];
  const queueUpdates: Array<{ name: string; options: unknown }> = [];
  const schedules: Array<{ name: string; cron: string; options: unknown }> = [];
  const workers = new Map<string, WorkHandler>();
  const boss: JobBoss = {
    async start() {
      calls.push("start");
    },
    async createQueue(name, options) {
      queues.push(name);
      calls.push(`createQueue:${name}:${JSON.stringify(options)}`);
    },
    async updateQueue(name, options) {
      queueUpdates.push({ name, options });
      calls.push(`updateQueue:${name}:${JSON.stringify(options)}`);
    },
    async work(name, handler) {
      workers.set(name, handler);
      calls.push(`work:${name}`);
    },
    async schedule(name, cron, _data, options) {
      schedules.push({ name, cron, options });
      calls.push(`schedule:${name}:${cron}`);
    },
  };
  return { boss, calls, queues, queueUpdates, schedules, workers };
}

test("registerJobs starts the boss and registers a queue, worker, and cron schedule per job", async () => {
  const fb = fakeBoss();
  const jobs: LoadedJob[] = [
    {
      name: "a.sync",
      schedule: "0 */6 * * *",
      expireInSeconds: 3_600,
      handler: async () => {},
    },
    { name: "b.sync", schedule: "*/5 * * * *", handler: async () => {} },
  ];

  await registerJobs(fb.boss, jobs);

  assert.equal(fb.calls[0], "start", "boss must be started before registration");
  assert.deepEqual(fb.queues, ["a.sync", "b.sync"]);
  assert.deepEqual(fb.schedules, [
    { name: "a.sync", cron: "0 */6 * * *", options: undefined },
    { name: "b.sync", cron: "*/5 * * * *", options: undefined },
  ]);
  // Each queue is created exclusive (at most one queued-or-active).
  assert.ok(fb.calls.includes('createQueue:a.sync:{"policy":"exclusive","expireInSeconds":3600}'));
  assert.deepEqual(fb.queueUpdates, [{ name: "a.sync", options: { expireInSeconds: 3_600 } }]);
});

test("the registered worker invokes the job handler", async () => {
  const fb = fakeBoss();
  let ran = 0;
  await registerJobs(fb.boss, [
    {
      name: "a.sync",
      schedule: "0 */6 * * *",
      handler: async () => {
        ran += 1;
      },
    },
  ]);

  const worker = fb.workers.get("a.sync");
  assert.ok(worker, "a worker should be registered for the queue");
  await worker([{ id: "job-1" }]);
  assert.equal(ran, 1);
});

test("registers an event consumer without a cron schedule and passes through its job payload", async () => {
  const fb = fakeBoss();
  let received: unknown;
  await registerJobs(fb.boss, [
    {
      name: "user.created",
      policy: "standard",
      handler: async (job) => {
        received = job;
      },
    },
  ]);

  assert.deepEqual(fb.schedules, []);
  assert.ok(fb.calls.includes('createQueue:user.created:{"policy":"standard"}'));
  const worker = fb.workers.get("user.created");
  assert.ok(worker);
  await worker([{ id: "job-1", data: { userId: "user-1" } }]);
  assert.deepEqual(received, { id: "job-1", data: { userId: "user-1" } });
});

test("a job that fails to register is skipped without aborting the others", async () => {
  const fb = fakeBoss();
  const boss: JobBoss = {
    ...fb.boss,
    async createQueue(name, options) {
      if (name === "bad.sync") throw new Error("createQueue failed");
      return fb.boss.createQueue(name, options);
    },
  };
  await registerJobs(boss, [
    { name: "bad.sync", schedule: "* * * * *", handler: async () => {} },
    { name: "good.sync", schedule: "* * * * *", handler: async () => {} },
  ]);

  // good.sync still got scheduled despite bad.sync throwing.
  assert.deepEqual(fb.schedules, [{ name: "good.sync", cron: "* * * * *", options: undefined }]);
});

test("a job's timezone is passed through to the cron schedule; a job without one is not", async () => {
  const fb = fakeBoss();
  await registerJobs(fb.boss, [
    { name: "tz.sync", schedule: "30 8 * * *", tz: "Europe/Rome", handler: async () => {} },
    { name: "utc.sync", schedule: "0 8 * * *", handler: async () => {} },
  ]);

  assert.deepEqual(fb.schedules, [
    { name: "tz.sync", cron: "30 8 * * *", options: { tz: "Europe/Rome" } },
    { name: "utc.sync", cron: "0 8 * * *", options: undefined },
  ]);
});
