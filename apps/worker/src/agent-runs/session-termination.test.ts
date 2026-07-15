import "../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { schema } from "@superlog/db";
import { terminatePendingAgentRunSessions } from "./session-termination.js";

test("detached cleanup terminates the losing session and leaves the owned session untouched", async () => {
  const calls: string[] = [];
  const run = {
    id: "run-1",
    runtime: "owned-runtime",
    providerSessionId: "owned-session",
    providerSessionStatus: "running",
  } as schema.AgentRun;

  const terminated = await terminatePendingAgentRunSessions(run, {
    async listDetached() {
      return [
        {
          id: "event-1",
          runtime: "detached-runtime",
          providerSessionId: "losing-session",
        },
      ];
    },
    async getRunnerBackend(runtime) {
      calls.push(`backend:${runtime}`);
      return {
        async terminate(sessionId: string) {
          calls.push(`terminate:${sessionId}`);
        },
      } as never;
    },
    async markOwnedTerminated() {
      calls.push("mark-owned");
    },
    async markDetachedTerminated(eventId) {
      calls.push(`mark-detached:${eventId}`);
    },
  });

  assert.equal(terminated, true);
  assert.deepEqual(calls, [
    "backend:detached-runtime",
    "terminate:losing-session",
    "mark-detached:event-1",
  ]);
});

test("owned cleanup retries a terminal run's attached session", async () => {
  const calls: string[] = [];
  const run = {
    id: "run-1",
    runtime: "owned-runtime",
    providerSessionId: "owned-session",
    providerSessionStatus: "termination_pending",
  } as schema.AgentRun;

  const terminated = await terminatePendingAgentRunSessions(run, {
    async listDetached() {
      return [];
    },
    async getRunnerBackend(runtime) {
      calls.push(`backend:${runtime}`);
      return {
        async terminate(sessionId: string) {
          calls.push(`terminate:${sessionId}`);
        },
      } as never;
    },
    async markOwnedTerminated(opts) {
      calls.push(`mark-owned:${opts.providerSessionId}`);
    },
    async markDetachedTerminated() {
      calls.push("mark-detached");
    },
  });

  assert.equal(terminated, true);
  assert.deepEqual(calls, [
    "backend:owned-runtime",
    "terminate:owned-session",
    "mark-owned:owned-session",
  ]);
});
