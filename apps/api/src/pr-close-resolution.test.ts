import assert from "node:assert/strict";
import { test } from "node:test";
import type { schema } from "@superlog/db";

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

const mergedSibling = {
  id: "agent-pr-2",
  incidentId: "incident-1",
  agentRunId: "agent-run-1",
  repoFullName: "acme/api",
  prNumber: 40,
  branchName: "fix/api-timeout-v1",
  url: "https://github.com/acme/api/pull/40",
  state: "merged",
  mergedAt: new Date("2026-07-14T10:00:00.000Z"),
  closedAt: new Date("2026-07-14T10:00:00.000Z"),
  mergedByLogin: "octocat",
} as schema.AgentPullRequest;

test("a close that settles the last live PR resolves the incident without asking the session", async () => {
  const calls: Array<{ kind: string; value?: unknown }> = [];

  const disposition = await resolveOrResumeIncidentForClosedAgentPr(
    { agentPr: closedPr, closedByLogin: "hubot", closedAt },
    {
      async listIncidentPullRequests() {
        return [closedPr];
      },
      async resolveSettled(input) {
        calls.push({ kind: "resolve", value: input });
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
});

test("a close with a merged sibling resolves as agent_pr_merged crediting the landed fix", async () => {
  const resolveInputs: Array<{ kind: string; reasonText: string }> = [];

  const disposition = await resolveOrResumeIncidentForClosedAgentPr(
    { agentPr: closedPr, closedByLogin: "hubot", closedAt },
    {
      async listIncidentPullRequests() {
        return [mergedSibling, closedPr];
      },
      async resolveSettled(input) {
        resolveInputs.push({ kind: input.kind, reasonText: input.reasonText ?? "" });
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
});

test("a close while another PR is still live falls back to the session continuation", async () => {
  const calls: string[] = [];

  const disposition = await resolveOrResumeIncidentForClosedAgentPr(
    { agentPr: closedPr, closedByLogin: "hubot", closedAt },
    {
      async listIncidentPullRequests() {
        return [closedPr, { ...closedPr, id: "agent-pr-3", state: "open" }];
      },
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
      async listIncidentPullRequests() {
        return [closedPr];
      },
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
