import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRunResult } from "@superlog/db";
import {
  reconcileDeliveredPullRequests,
  selectDeliveredPullRequestsForOutcome,
} from "./pr-result-reconciliation.js";

test("delivered pull requests replace proposal coordinates while retaining proposal context", () => {
  const result: AgentRunResult = {
    state: "awaiting_events",
    summary: "Fixed both services.",
    prs: [
      {
        selectedRepoFullName: "acme/worker",
        branchName: "superlog/fix-worker",
        baseBranch: "develop",
        title: "Proposed worker title",
        body: "Worker proposal body",
        patchFilePath: "/mnt/session/outputs/worker.patch",
        changedFiles: ["src/worker.ts"],
        openStatus: "opened",
      },
    ],
  };

  const reconciled = reconcileDeliveredPullRequests(result, [
    {
      repoFullName: "acme/api",
      branchName: "superlog/fix-api",
      baseBranch: "main",
      title: "Fix API retries",
      url: "https://github.com/acme/api/pull/12",
    },
    {
      repoFullName: "acme/worker",
      branchName: "superlog/fix-worker-2",
      baseBranch: "main",
      title: "Fix worker retries",
      url: "https://github.com/acme/worker/pull/34",
    },
  ]);

  assert.deepEqual(reconciled.prs, [
    {
      selectedRepoFullName: "acme/api",
      branchName: "superlog/fix-api",
      baseBranch: "main",
      title: "Fix API retries",
      openStatus: "opened",
      url: "https://github.com/acme/api/pull/12",
    },
    {
      selectedRepoFullName: "acme/worker",
      branchName: "superlog/fix-worker-2",
      baseBranch: "main",
      title: "Fix worker retries",
      body: "Worker proposal body",
      patchFilePath: "/mnt/session/outputs/worker.patch",
      changedFiles: ["src/worker.ts"],
      openStatus: "opened",
      url: "https://github.com/acme/worker/pull/34",
    },
  ]);
  assert.deepEqual(reconciled.pr, reconciled.prs?.[1]);
});

test("no delivered pull requests removes stale proposal-only PR metadata", () => {
  const result: AgentRunResult = {
    state: "awaiting_events",
    summary: "Waiting on an external fix.",
    pr: {
      selectedRepoFullName: "acme/api",
      branchName: "superlog/unopened-api-fix",
      baseBranch: "main",
      openStatus: "opened",
    },
  };

  const reconciled = reconcileDeliveredPullRequests(result, []);

  assert.equal(reconciled.prs, null);
  assert.equal(reconciled.pr, null);
});

test("same-repository deliveries receive proposal context at most once", () => {
  const result: AgentRunResult = {
    state: "awaiting_events",
    summary: "Fixed the API.",
    prs: [
      {
        selectedRepoFullName: "acme/api",
        branchName: "superlog/fix-api",
        baseBranch: "main",
        title: "Fix the API",
        body: "Current proposal body",
        patchFilePath: "/mnt/session/outputs/api.patch",
        openStatus: "opened",
      },
    ],
  };

  const reconciled = reconcileDeliveredPullRequests(
    result,
    [
      {
        id: "old-pr",
        agentRunId: "current-run",
        repoFullName: "acme/api",
        branchName: "superlog/fix-api",
        baseBranch: "main",
        title: "Old API fix",
        url: "https://github.com/acme/api/pull/10",
        state: "closed",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
      {
        id: "current-pr",
        agentRunId: "current-run",
        repoFullName: "acme/api",
        branchName: "superlog/fix-api-retry-a1b2c3d4",
        baseBranch: "main",
        title: "Fix the API",
        url: "https://github.com/acme/api/pull/11",
        state: "merged",
        createdAt: new Date("2026-01-02T00:00:00Z"),
      },
    ],
    { currentAgentRunId: "current-run" },
  );

  assert.deepEqual(reconciled.prs, [
    {
      selectedRepoFullName: "acme/api",
      branchName: "superlog/fix-api",
      baseBranch: "main",
      title: "Old API fix",
      openStatus: "opened",
      url: "https://github.com/acme/api/pull/10",
    },
    {
      selectedRepoFullName: "acme/api",
      branchName: "superlog/fix-api-retry-a1b2c3d4",
      baseBranch: "main",
      title: "Fix the API",
      body: "Current proposal body",
      patchFilePath: "/mnt/session/outputs/api.patch",
      openStatus: "opened",
      url: "https://github.com/acme/api/pull/11",
    },
  ]);
});

test("same-repository proposal context follows its requested branch", () => {
  const result: AgentRunResult = {
    state: "awaiting_events",
    summary: "Delivered two revisions.",
    prs: [
      {
        selectedRepoFullName: "acme/api",
        branchName: "superlog/fix-v1",
        baseBranch: "main",
        body: "First revision context",
        openStatus: "opened",
      },
      {
        selectedRepoFullName: "acme/api",
        branchName: "superlog/fix-v2",
        baseBranch: "main",
        body: "Second revision context",
        openStatus: "opened",
      },
    ],
  };

  const reconciled = reconcileDeliveredPullRequests(result, [
    {
      repoFullName: "acme/api",
      branchName: "superlog/fix-v2",
      baseBranch: "main",
      title: "Second revision",
      url: "https://github.com/acme/api/pull/2",
    },
    {
      repoFullName: "acme/api",
      branchName: "superlog/fix-v1",
      baseBranch: "main",
      title: "First revision",
      url: "https://github.com/acme/api/pull/1",
    },
  ]);

  assert.equal(reconciled.prs?.[0]?.body, "Second revision context");
  assert.equal(reconciled.prs?.[1]?.body, "First revision context");
});

test("terminal reconciliation selects only canonical rows named by the outcome", () => {
  const result: AgentRunResult = {
    state: "awaiting_events",
    summary: "Delivered the current fix.",
    prs: [
      {
        selectedRepoFullName: "acme/api",
        branchName: "superlog/fix-current",
        baseBranch: "main",
        openStatus: "opened",
        url: "https://github.com/acme/api/pull/12",
      },
    ],
  };
  const rows = [
    {
      agentRunId: "old-run",
      repoFullName: "acme/web",
      branchName: "superlog/old-fix",
      baseBranch: "main",
      title: "Old fix",
      url: "https://github.com/acme/web/pull/3",
      state: "closed" as const,
    },
    {
      agentRunId: "old-run",
      repoFullName: "acme/api",
      branchName: "superlog/fix-current",
      baseBranch: "main",
      title: "Current fix",
      url: "https://github.com/acme/api/pull/12",
      state: "merged" as const,
    },
  ];

  assert.deepEqual(selectDeliveredPullRequestsForOutcome(result, rows, "current-run"), [rows[1]]);
});

test("legacy outcomes without URLs prefer rows recorded by the current run", () => {
  const result: AgentRunResult = {
    state: "awaiting_events",
    summary: "Delivered a fix.",
    prs: [
      {
        selectedRepoFullName: "acme/api",
        branchName: "superlog/fix-api",
        baseBranch: "main",
        openStatus: "opened",
      },
    ],
  };
  const rows = [
    {
      agentRunId: "old-run",
      repoFullName: "acme/web",
      branchName: "superlog/old-fix",
      baseBranch: "main",
      title: "Old fix",
      url: "https://github.com/acme/web/pull/3",
      state: "closed" as const,
    },
    {
      agentRunId: "current-run",
      repoFullName: "acme/api",
      branchName: "superlog/fix-api",
      baseBranch: "main",
      title: "Current fix",
      url: "https://github.com/acme/api/pull/12",
      state: "merged" as const,
    },
  ];

  assert.deepEqual(selectDeliveredPullRequestsForOutcome(result, rows, "current-run"), [rows[1]]);
});
