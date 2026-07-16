import assert from "node:assert/strict";
import { test } from "node:test";
import {
  areAllIncidentPullRequestsMerged,
  areAllIncidentPullRequestsSettled,
  buildAgentPullRequestLifecycleContinuation,
} from "./agent-pr-lifecycle-continuation.js";

test("all Incident PRs must be merged before merge fallback may resolve", () => {
  assert.equal(areAllIncidentPullRequestsMerged([]), false);
  assert.equal(areAllIncidentPullRequestsMerged([{ state: "merged" }]), true);
  assert.equal(areAllIncidentPullRequestsMerged([{ state: "merged" }, { state: "merged" }]), true);
  assert.equal(areAllIncidentPullRequestsMerged([{ state: "merged" }, { state: "open" }]), false);
  assert.equal(areAllIncidentPullRequestsMerged([{ state: "merged" }, { state: "closed" }]), false);
});

test("all Incident PRs must be settled before a close may resolve", () => {
  assert.equal(areAllIncidentPullRequestsSettled([]), false);
  assert.equal(areAllIncidentPullRequestsSettled([{ state: "closed" }]), true);
  assert.equal(areAllIncidentPullRequestsSettled([{ state: "merged" }, { state: "closed" }]), true);
  assert.equal(areAllIncidentPullRequestsSettled([{ state: "merged" }, { state: "merged" }]), true);
  assert.equal(areAllIncidentPullRequestsSettled([{ state: "closed" }, { state: "open" }]), false);
});

test("buildAgentPullRequestLifecycleContinuation describes merged and closed PR events", () => {
  const merged = buildAgentPullRequestLifecycleContinuation({
    pullRequest: {
      id: "agent-pr-1",
      state: "merged",
      url: "https://github.com/acme/api/pull/1",
      repoFullName: "acme/api",
      branchName: "ash/fix-api",
      prNumber: 1,
      mergedAt: new Date("2026-07-15T08:30:00.000Z"),
      closedAt: null,
      mergedByLogin: "octocat",
    },
  });
  assert.deepEqual(merged, {
    interaction: {
      channel: "pr_merged",
      agentPrId: "agent-pr-1",
      author: "octocat",
      text: "Your PR #1 (acme/api, branch `ash/fix-api`) was merged by @octocat. If this completes the remediation, make sure every linked issue is classified and call resolve_incident; if more work remains (other PRs still open, issues unclassified), continue it.",
      url: "https://github.com/acme/api/pull/1",
      occurredAt: "2026-07-15T08:30:00.000Z",
    },
    dedupeKey: "agent_pr_merged:agent-pr-1",
  });

  const closed = buildAgentPullRequestLifecycleContinuation({
    pullRequest: {
      id: "agent-pr-2",
      state: "closed",
      url: "https://github.com/acme/web/pull/2",
      repoFullName: "acme/web",
      branchName: "ash/fix-web",
      prNumber: 2,
      mergedAt: null,
      closedAt: new Date("2026-07-15T08:45:00.000Z"),
      mergedByLogin: null,
    },
    actorLogin: "hubot",
  });
  assert.deepEqual(closed, {
    interaction: {
      channel: "pr_closed",
      agentPrId: "agent-pr-2",
      author: "hubot",
      text: "Your PR #2 (acme/web, branch `ash/fix-web`) was closed without being merged by @hubot. Read the PR conversation for the close context: if it shows the incident is actually noise, classify the issues accordingly and call resolve_incident; if the fix is still needed, decide the next step (an adjusted PR, or ask_human).",
      url: "https://github.com/acme/web/pull/2",
      occurredAt: "2026-07-15T08:45:00.000Z",
    },
    dedupeKey: "agent_pr_closed:agent-pr-2:1784105100000",
  });
});

test("buildAgentPullRequestLifecycleContinuation gives recovered closes a stable dedupe key", () => {
  const recovered = buildAgentPullRequestLifecycleContinuation({
    pullRequest: {
      id: "agent-pr-2",
      state: "closed",
      url: "https://github.com/acme/web/pull/2",
      repoFullName: "acme/web",
      branchName: "ash/fix-web",
      prNumber: 2,
      mergedAt: null,
      closedAt: null,
      mergedByLogin: null,
    },
    fallbackOccurredAt: new Date("2026-07-15T09:00:00.000Z"),
  });

  assert.equal(recovered?.interaction.occurredAt, "2026-07-15T09:00:00.000Z");
  assert.equal(recovered?.dedupeKey, "agent_pr_closed:agent-pr-2:recovered");
});
