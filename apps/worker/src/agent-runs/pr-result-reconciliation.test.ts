import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRunResult } from "@superlog/db";
import { reconcileDeliveredPullRequests } from "./pr-result-reconciliation.js";

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
