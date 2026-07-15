import assert from "node:assert/strict";
import { test } from "node:test";
import { loadGithubPullRequestProviderObservation } from "./github-pr-provider.js";

test("loads and translates GitHub's authoritative current pull request state", async () => {
  const requestedPaths: string[] = [];
  const observedAt = new Date("2026-07-15T10:05:02.000Z");

  const observation = await loadGithubPullRequestProviderObservation({
    repoFullName: "acme/api",
    prNumber: 42,
    observedAt,
    async request(pathname) {
      requestedPaths.push(pathname);
      return {
        state: "closed",
        merged: false,
        updated_at: "2026-07-15T10:00:01Z",
        closed_at: "2026-07-15T10:00:01Z",
        merged_at: null,
        merged_by: null,
        title: "Fix the incident",
        head: { sha: "abc123" },
      };
    },
  });

  assert.deepEqual(requestedPaths, ["/repos/acme/api/pulls/42"]);
  assert.deepEqual(observation, {
    targetState: "closed",
    observedAt,
    providerUpdatedAt: new Date("2026-07-15T10:00:01Z"),
    headSha: "abc123",
    title: "Fix the incident",
    mergedAt: null,
    closedAt: new Date("2026-07-15T10:00:01Z"),
    mergedByLogin: null,
    mergedByGithubId: null,
  });
});

test("authoritative GitHub state treats a merged pull request as irreversible", async () => {
  const observedAt = new Date("2026-07-15T10:05:02.000Z");
  const observation = await loadGithubPullRequestProviderObservation({
    repoFullName: "acme/api",
    prNumber: 42,
    observedAt,
    async request() {
      return {
        state: "closed",
        merged: true,
        updated_at: "2026-07-15T10:00:01Z",
        closed_at: "2026-07-15T10:00:01Z",
        merged_at: "2026-07-15T10:00:01Z",
        merged_by: { login: "octocat", id: 7 },
        title: "Fix the incident",
        head: { sha: "abc123" },
      };
    },
  });

  assert.equal(observation.targetState, "merged");
  assert.equal(observation.mergedByLogin, "octocat");
  assert.equal(observation.mergedByGithubId, 7);
});
