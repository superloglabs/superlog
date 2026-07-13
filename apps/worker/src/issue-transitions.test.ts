import assert from "node:assert/strict";
import { test } from "node:test";
import type { schema } from "@superlog/db";
import {
  ISSUE_TRANSITION_QUEUE,
  type TransitionQueueBoss,
  createIssueTransitionDispatcher,
  registerIssueTransitionWorker,
} from "./issue-transitions.js";

function issueOf(id: string, projectId: string): schema.Issue {
  return { id, projectId } as schema.Issue;
}

type SentJob = { name: string; data: unknown; options: unknown };
type WorkHandler = (jobs: Array<{ id: string; data: unknown }>) => Promise<unknown>;

function fakeBoss() {
  const sent: SentJob[] = [];
  const queues: Array<{ name: string; options: unknown }> = [];
  const workers = new Map<string, WorkHandler>();
  const workOptions = new Map<string, unknown>();
  const boss: TransitionQueueBoss = {
    async createQueue(name, options) {
      queues.push({ name, options });
    },
    async work(name, options, handler) {
      workers.set(name, handler as WorkHandler);
      workOptions.set(name, options);
    },
    async send(name, data, options) {
      sent.push({ name, data, options });
      return "job-id";
    },
  };
  return { boss, sent, queues, workers, workOptions };
}

test("dispatcher enqueues the transition instead of running it inline", async () => {
  const fb = fakeBoss();
  let inlineRuns = 0;
  const dispatch = createIssueTransitionDispatcher({
    boss: fb.boss,
    inline: async () => {
      inlineRuns += 1;
    },
  });

  await dispatch(issueOf("issue-1", "project-1"), "new");

  assert.equal(inlineRuns, 0, "inline handler must not run when the queue is available");
  assert.equal(fb.sent.length, 1);
  assert.equal(fb.sent[0]?.name, ISSUE_TRANSITION_QUEUE);
  assert.deepEqual(fb.sent[0]?.data, {
    issueId: "issue-1",
    projectId: "project-1",
    transition: "new",
  });
  // Rapid duplicate dispatches of the same (issue, transition) must dedupe
  // while a matching job is still queued.
  assert.deepEqual(fb.sent[0]?.options, { singletonKey: "issue-1:new" });
});

test("dispatcher runs inline when no queue is configured", async () => {
  const calls: Array<{ issueId: string; transition: string }> = [];
  const dispatch = createIssueTransitionDispatcher({
    boss: null,
    inline: async (issue, transition) => {
      calls.push({ issueId: issue.id, transition });
    },
  });

  await dispatch(issueOf("issue-1", "project-1"), "recurred");

  assert.deepEqual(calls, [{ issueId: "issue-1", transition: "recurred" }]);
});

test("dispatcher falls back to inline when enqueue fails", async () => {
  const fb = fakeBoss();
  const boss: TransitionQueueBoss = {
    ...fb.boss,
    async send() {
      throw new Error("pg-boss unavailable");
    },
  };
  let inlineRuns = 0;
  const dispatch = createIssueTransitionDispatcher({
    boss,
    inline: async () => {
      inlineRuns += 1;
    },
  });

  await dispatch(issueOf("issue-1", "project-1"), "new");

  assert.equal(inlineRuns, 1, "a failed enqueue must not drop the transition");
});

test("worker registration creates a standard queue and a batch worker", async () => {
  const fb = fakeBoss();
  await registerIssueTransitionWorker(fb.boss, {
    handle: async () => {},
    loadIssue: async () => null,
  });

  assert.equal(fb.queues.length, 1);
  assert.equal(fb.queues[0]?.name, ISSUE_TRANSITION_QUEUE);
  // Standard (default) policy: many transitions may be queued at once,
  // unlike the exclusive cron-job queues.
  assert.equal(fb.queues[0]?.options, undefined);
  assert.ok(fb.workers.get(ISSUE_TRANSITION_QUEUE), "a worker must be registered");
  // Independent single-job consumers, not a fetch batch: pg-boss completes a
  // batch only when the whole handler resolves, so batchSize > 1 lets one
  // hung LLM grouping call pin every fetched transition until queue expiry.
  assert.deepEqual(fb.workOptions.get(ISSUE_TRANSITION_QUEUE), {
    batchSize: 1,
    localConcurrency: 5,
  });
});

test("the queue worker reloads each issue and runs the handler", async () => {
  const fb = fakeBoss();
  const handled: Array<{ issueId: string; transition: string }> = [];
  await registerIssueTransitionWorker(fb.boss, {
    handle: async (issue, transition) => {
      handled.push({ issueId: issue.id, transition });
    },
    loadIssue: async (id) => (id === "gone" ? null : issueOf(id, "project-1")),
  });

  const worker = fb.workers.get(ISSUE_TRANSITION_QUEUE);
  assert.ok(worker);
  await worker([
    { id: "j1", data: { issueId: "issue-1", projectId: "project-1", transition: "new" } },
    { id: "j2", data: { issueId: "gone", projectId: "project-1", transition: "new" } },
    { id: "j3", data: { issueId: "issue-2", projectId: "project-1", transition: "recurred" } },
  ]);

  assert.deepEqual(handled, [
    { issueId: "issue-1", transition: "new" },
    { issueId: "issue-2", transition: "recurred" },
  ]);
});

test("one failing transition does not abort the rest of the batch or throw", async () => {
  const fb = fakeBoss();
  const handled: string[] = [];
  await registerIssueTransitionWorker(fb.boss, {
    handle: async (issue) => {
      if (issue.id === "boom") throw new Error("grouping exploded");
      handled.push(issue.id);
    },
    loadIssue: async (id) => issueOf(id, "project-1"),
  });

  const worker = fb.workers.get(ISSUE_TRANSITION_QUEUE);
  assert.ok(worker);
  // Must not reject: side effects are at-most-once (same as the previous
  // inline path, which logged and skipped failures).
  await worker([
    { id: "j1", data: { issueId: "boom", projectId: "project-1", transition: "new" } },
    { id: "j2", data: { issueId: "issue-2", projectId: "project-1", transition: "new" } },
  ]);

  assert.deepEqual(handled, ["issue-2"]);
});

test("observation escalations dispatch through the queue too", async () => {
  const fb = fakeBoss();
  const dispatch = createIssueTransitionDispatcher({
    boss: fb.boss,
    inline: async () => {},
  });

  await dispatch(issueOf("issue-1", "project-1"), "escalated");

  assert.deepEqual(fb.sent[0]?.data, {
    issueId: "issue-1",
    projectId: "project-1",
    transition: "escalated",
  });

  const handled: string[] = [];
  await registerIssueTransitionWorker(fb.boss, {
    handle: async (_issue, transition) => {
      handled.push(transition);
    },
    loadIssue: async (id) => issueOf(id, "project-1"),
  });
  const worker = fb.workers.get(ISSUE_TRANSITION_QUEUE);
  assert.ok(worker);
  await worker([{ id: "j1", data: fb.sent[0]?.data }]);
  assert.deepEqual(handled, ["escalated"]);
});

test("the queue worker skips malformed job payloads", async () => {
  const fb = fakeBoss();
  const handled: string[] = [];
  await registerIssueTransitionWorker(fb.boss, {
    handle: async (issue) => {
      handled.push(issue.id);
    },
    loadIssue: async (id) => issueOf(id, "project-1"),
  });

  const worker = fb.workers.get(ISSUE_TRANSITION_QUEUE);
  assert.ok(worker);
  await worker([
    { id: "j1", data: null },
    { id: "j2", data: { issueId: "issue-1", projectId: "p", transition: "seen" } },
    { id: "j3", data: { issueId: "issue-2", projectId: "p", transition: "new" } },
  ]);

  assert.deepEqual(handled, ["issue-2"]);
});
