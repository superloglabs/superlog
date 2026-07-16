import assert from "node:assert/strict";
import { test } from "node:test";
import type { IncidentAgentPullRequestSnapshot, schema } from "@superlog/db";

process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";
process.env.BETTER_AUTH_SECRET ??= "test-better-auth-secret-with-enough-length";

const { resolveOrResumeIncidentForClosedAgentPr } = await import("./github.js");

const closedAt = new Date("2026-07-15T10:00:00.000Z");
const closedPr = {
  id: "agent-pr-1",
  incidentId: "incident-1",
  agentRunId: "agent-run-1",
  repoFullName: "acme/api",
  prNumber: 42,
  branchName: "fix/api-timeout",
  url: "https://github.com/acme/api/pull/42",
  state: "closed",
  mergedAt: null,
  closedAt,
  mergedByLogin: null,
} as schema.AgentPullRequest;

const closedSnapshot: IncidentAgentPullRequestSnapshot = {
  id: "agent-pr-1",
  state: "closed",
  prNumber: 42,
  repoFullName: "acme/api",
  url: "https://github.com/acme/api/pull/42",
  mergedAt: null,
  closedAt,
};

// Merged after the close settled: the resolution must be stamped at the merge,
// not backdated to the close.
const laterMergedAt = new Date("2026-07-16T10:00:00.000Z");
const mergedSnapshot: IncidentAgentPullRequestSnapshot = {
  id: "agent-pr-2",
  state: "merged",
  prNumber: 40,
  repoFullName: "acme/api",
  url: "https://github.com/acme/api/pull/40",
  mergedAt: laterMergedAt,
  closedAt: laterMergedAt,
};

test("a close that settles the last live PR resolves the incident without asking the session", async () => {
  const calls: Array<{ kind: string; value?: unknown }> = [];

  const disposition = await resolveOrResumeIncidentForClosedAgentPr(
    { agentPr: closedPr, closedByLogin: "hubot", closedAt },
    {
      async resolveSettled(opts) {
        calls.push({ kind: "resolve", value: opts.buildInput([closedSnapshot]) });
        return { disposition: "resolved", resolved: true, resolvedIssueCount: 2 };
      },
      async runResolvedSideEffects(incidentId) {
        calls.push({ kind: "side_effects", value: incidentId });
      },
      async continueInSession() {
        calls.push({ kind: "continue" });
        return "continued_in_session";
      },
    },
  );

  assert.equal(disposition, "resolved");
  assert.deepEqual(
    calls.map((call) => call.kind),
    ["resolve", "side_effects"],
  );
  const resolveInput = calls[0]?.value as {
    incidentId: string;
    kind: string;
    reasonCode: string;
    reasonText: string;
    eventDedupeKey: string;
    resolvedAt: Date;
  };
  assert.equal(resolveInput.incidentId, "incident-1");
  assert.equal(resolveInput.kind, "agent_pr_closed");
  assert.equal(resolveInput.reasonCode, "agent_pr_closed");
  assert.match(resolveInput.reasonText, /#42/);
  assert.match(resolveInput.reasonText, /@hubot/);
  assert.equal(
    resolveInput.eventDedupeKey,
    `incident_resolved:agent_pr_closed:agent-pr-1:${closedAt.getTime()}`,
  );
  assert.equal(resolveInput.resolvedAt, closedAt);
  assert.equal(calls[1]?.value, "incident-1");
});

test("a close with a merged sibling in the locked snapshot resolves as agent_pr_merged", async () => {
  const resolveInputs: Array<{ kind: string; reasonText: string; resolvedAt: Date | undefined }> =
    [];

  const disposition = await resolveOrResumeIncidentForClosedAgentPr(
    { agentPr: closedPr, closedByLogin: "hubot", closedAt },
    {
      async resolveSettled(opts) {
        const input = opts.buildInput([mergedSnapshot, closedSnapshot]);
        resolveInputs.push({
          kind: input.kind,
          reasonText: input.reasonText ?? "",
          resolvedAt: input.resolvedAt,
        });
        return { disposition: "resolved", resolved: true, resolvedIssueCount: 1 };
      },
      async runResolvedSideEffects() {},
      async continueInSession() {
        throw new Error("session must not be consulted");
      },
    },
  );

  assert.equal(disposition, "resolved");
  assert.equal(resolveInputs[0]?.kind, "agent_pr_merged");
  assert.match(resolveInputs[0]?.reasonText ?? "", /#40/);
  assert.match(resolveInputs[0]?.reasonText ?? "", /#42/);
  // The sibling merged after this close: the resolution is stamped at the
  // merge, not backdated to the close.
  assert.deepEqual(resolveInputs[0]?.resolvedAt, laterMergedAt);
});

test("a close while another PR is still live falls back to the session continuation", async () => {
  const calls: string[] = [];

  const disposition = await resolveOrResumeIncidentForClosedAgentPr(
    { agentPr: closedPr, closedByLogin: "hubot", closedAt },
    {
      async resolveSettled() {
        calls.push("resolve");
        return { disposition: "pull_requests_pending", resolved: false, resolvedIssueCount: 0 };
      },
      async runResolvedSideEffects() {
        calls.push("side_effects");
      },
      async continueInSession(opts) {
        calls.push("continue");
        assert.equal(opts.continuation.interaction.channel, "pr_closed");
        return "continued_in_session";
      },
    },
  );

  assert.equal(disposition, "continued_in_session");
  assert.deepEqual(calls, ["resolve", "continue"]);
});

test("a close on an already-resolved incident is a no-op", async () => {
  const calls: string[] = [];

  const disposition = await resolveOrResumeIncidentForClosedAgentPr(
    { agentPr: closedPr, closedByLogin: null, closedAt },
    {
      async resolveSettled() {
        calls.push("resolve");
        return { disposition: "incident_not_open", resolved: false, resolvedIssueCount: 0 };
      },
      async runResolvedSideEffects() {
        calls.push("side_effects");
      },
      async continueInSession() {
        calls.push("continue");
        return "no_resumable_session";
      },
    },
  );

  assert.equal(disposition, "incident_not_open");
  assert.deepEqual(calls, ["resolve"]);
});
