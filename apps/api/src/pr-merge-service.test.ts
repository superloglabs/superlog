import assert from "node:assert/strict";
import { test } from "node:test";
import type { schema } from "@superlog/db";

process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";
process.env.BETTER_AUTH_SECRET ??= "test-better-auth-secret-with-enough-length";

const { resolveIncidentAfterManualAgentPullRequestMerge } = await import("./pr-merge-service.js");

const mergedAt = new Date("2026-07-15T10:00:00.000Z");
const pr = {
  id: "agent-pr-1",
  incidentId: "incident-1",
  agentRunId: "agent-run-1",
  repoFullName: "acme/api",
  prNumber: 42,
  url: "https://github.com/acme/api/pull/42",
} as schema.AgentPullRequest;

test("manual merge reports waiting while a sibling PR remains open", async () => {
  const calls: string[] = [];

  const resolved = await resolveIncidentAfterManualAgentPullRequestMerge(
    {
      pr,
      source: "dashboard",
      mergedAt,
    },
    {
      async continueOrResolveMergedPullRequest() {
        calls.push("continue");
        return "pull_requests_pending";
      },
    },
  );

  assert.equal(resolved, "waiting_for_pull_requests");
  assert.deepEqual(calls, ["continue"]);
});

test("manual merge reports resolved after the continuation path applies its fallback", async () => {
  const calls: Array<{ kind: string; value?: unknown }> = [];

  const resolved = await resolveIncidentAfterManualAgentPullRequestMerge(
    {
      pr,
      source: "dashboard",
      mergedAt,
    },
    {
      async continueOrResolveMergedPullRequest(input) {
        calls.push({ kind: "continue", value: input });
        return "resolved";
      },
    },
  );

  assert.equal(resolved, "resolved");
  assert.equal(calls[0]?.kind, "continue");
  assert.deepEqual(calls[0]?.value, {
    agentPr: pr,
    mergedAt,
    mergedByLogin: null,
    source: "dashboard",
  });
});

test("manual merge reports already resolved when another resolver won", async () => {
  const resolved = await resolveIncidentAfterManualAgentPullRequestMerge(
    {
      pr,
      source: "dashboard",
      mergedAt,
    },
    {
      async continueOrResolveMergedPullRequest() {
        return "incident_not_open";
      },
    },
  );

  assert.equal(resolved, "already_resolved");
});

test("manual merge gives a surviving session the merge event before deterministic resolution", async () => {
  const calls: string[] = [];
  const deps = {
    async continueOrResolveMergedPullRequest() {
      calls.push("continue");
      return "continued_in_session" as const;
    },
  };

  const disposition = await resolveIncidentAfterManualAgentPullRequestMerge(
    { pr, source: "dashboard", mergedAt },
    deps,
  );

  assert.equal(disposition, "continued_in_session");
  assert.deepEqual(calls, ["continue"]);
});
